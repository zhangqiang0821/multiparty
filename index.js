/*!
 * multiparty
 * Copyright(c) 2013 Felix Geisendörfer
 * Copyright(c) 2014 Andrew Kelley
 * Copyright(c) 2014 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

var createError = require('http-errors')
var uid = require('uid-safe')
var stream = require('stream');
var util = require('util');
var fs = require('fs');
var path = require('path');
var os = require('os');
var Buffer = require('safe-buffer').Buffer
var StringDecoder = require('string_decoder').StringDecoder;
var fdSlicer = require('fd-slicer');

var START = 0;
var START_BOUNDARY = 1;
var HEADER_FIELD_START = 2;
var HEADER_FIELD = 3;
var HEADER_VALUE_START = 4;
var HEADER_VALUE = 5;
var HEADER_VALUE_ALMOST_DONE = 6;
var HEADERS_ALMOST_DONE = 7;
var PART_DATA_START = 8;
var PART_DATA = 9;
var CLOSE_BOUNDARY = 10;
var END = 11;

var LF = 10;
var CR = 13;
var SPACE = 32;
var HYPHEN = 45;
var COLON = 58;
var A = 97;
var Z = 122;

var CONTENT_TYPE_RE = /^multipart\/(?:form-data|related)(?:;|$)/i;
var CONTENT_TYPE_PARAM_RE = /;\s*([^=]+)=(?:"([^"]+)"|([^;]+))/gi;
var FILE_EXT_RE = /(\.[_\-a-zA-Z0-9]{0,16})[\S\s]*/;
var LAST_BOUNDARY_SUFFIX_LEN = 4; // --\r\n

exports.Form = Form;

util.inherits(Form, stream.Writable);
function Form(options) {
  var opts = options || {}
  var self = this;
  stream.Writable.call(self);

  self.error = null;

  self.autoFields = !!opts.autoFields
  self.autoFiles = !!opts.autoFiles

  self.maxFields = opts.maxFields || 1000
  self.maxFieldsSize = opts.maxFieldsSize || 2 * 1024 * 1024
  self.maxFilesSize = opts.maxFilesSize || Infinity
  self.uploadDir = opts.uploadDir || os.tmpdir()
  self.encoding = opts.encoding || 'utf8'

  self.bytesReceived = 0;
  self.bytesExpected = null;

  self.openedFiles = [];  // 接受的文件列表
  self.totalFieldSize = 0;
  self.totalFieldCount = 0;
  self.totalFileSize = 0;
  self.flushing = 0;

  self.backpressure = false;
  self.writeCbs = [];

  self.emitQueue = [];

  // 监听添加 file 事件与 field 事件
  self.on('newListener', function(eventName) {
    if (eventName === 'file') {
      self.autoFiles = true;
    } else if (eventName === 'field') {
      self.autoFields = true;
    }
  });
}

Form.prototype.parse = function(req, cb) {
  var called = false;
  var self = this;
  var waitend = true;

  if (cb) {
    // if the user supplies a callback, this implies autoFields and autoFiles
    self.autoFields = true;
    self.autoFiles = true;

    // wait for request to end before calling cb
    var end = function (done) {
      if (called) return;

      called = true;

      // wait for req events to fire
      process.nextTick(function() {
        if (waitend && req.readable) {
          // dump rest of request
          req.resume();
          req.once('end', done);
          return;
        }

        done();
      });
    };

    var fields = {};
    var files = {};
    self.on('error', function(err) {
      end(function() {
        cb(err);
      });
    });
    self.on('field', function(name, value) {
      var fieldsArray = fields[name] || (fields[name] = []);
      fieldsArray.push(value);
    });
    self.on('file', function(name, file) {
      var filesArray = files[name] || (files[name] = []);
      filesArray.push(file);
    });
    self.on('close', function() {
      end(function() {
        cb(null, fields, files);
      });
    });
  }

  self.handleError = handleError;
  self.bytesExpected = getBytesExpected(req.headers); // 773

  req.on('end', onReqEnd);
  req.on('error', function(err) {
    waitend = false;
    handleError(err);
  });
  req.on('aborted', onReqAborted);

  var state = req._readableState;
  if (req._decoder || (state && (state.encoding || state.decoder))) {
    // this is a binary protocol
    // if an encoding is set, input is likely corrupted
    validationError(new Error('request encoding must not be set'));
    return;
  }

  var contentType = req.headers['content-type'];
  if (!contentType) {
    validationError(createError(415, 'missing content-type header'));
    return;
  }

  var m = CONTENT_TYPE_RE.exec(contentType);
  if (!m) {
    validationError(createError(415, 'unsupported content-type'));
    return;
  }

  var boundary;
  CONTENT_TYPE_PARAM_RE.lastIndex = m.index + m[0].length - 1;
  while ((m = CONTENT_TYPE_PARAM_RE.exec(contentType))) {
    if (m[1].toLowerCase() !== 'boundary') continue;
    boundary = m[2] || m[3];
    break;
  }

  if (!boundary) {
    validationError(createError(400, 'content-type missing boundary'));
    return;
  }

  setUpParser(self, boundary);
  req.pipe(self);
  function onReqAborted() {
    waitend = false;
    self.emit('aborted');
    handleError(new Error("Request aborted"));
  }

  function onReqEnd() {
    waitend = false;
  }

  function handleError(err) {
    var first = !self.error;
    if (first) {
      self.error = err;
      req.removeListener('aborted', onReqAborted);
      req.removeListener('end', onReqEnd);
      if (self.destStream) {
        errorEventQueue(self, self.destStream, err);
      }
    }

    cleanupOpenFiles(self);

    if (first) {
      self.emit('error', err);
    }
  }
  function validationError(err) {
    // handle error on next tick for event listeners to attach
    process.nextTick(handleError.bind(null, err))
  }
};
// 首先童鞋们一定要注意源码 line:50 位置的`util.inherits(Form, stream.Writable)``
// 大家看到这个方法可能会找不到此包在哪里调用，其实这关键的操作在于包一旦引入便进行了 写入流 stream.Writable 继承 Form 的操作，原本可写流的内部方法 writable._write 被 Form 原型中的 _write 先传入底层
// 由此达到每次 transform 流都会调用我们在这里重写的 _write 方法，在 parse 方法的最后调用 req.pipe(self) 时将 req 写入 Form 实例时触发
// 由于 pipe 的原理实际就是监测 Readable 的 data 事件，然后在其中不停调用 Writable.write(chunk)，我们可以在 Form.protoytpe._write 中 log 出一个数字标记，然后在 Form.protoytpe.parse 的 req.pipe(self) 前后 log 标记，不过一定记得在后 log 时一定要使用 nextTick 跳过本次 event loop 的主进程循环，因为 pipe 是在异步的，是 event loop 的第一次 macro task，否则将一定会是后标记先出现在控制台
Form.prototype._write = function(buffer, encoding, cb) {
  if (this.error) return;

  var self = this;
  var i = 0;
  var len = buffer.length;  // 轮询表单数据 buffer 的长度
  var prevIndex = self.index;
  var index = self.index;
  var state = self.state; // 轮询表单数据 buffer 时的状态
  var lookbehind = self.lookbehind;
  var boundary = self.boundary; // 通过 parse 方法里拿到的分隔符 boundary
  var boundaryChars = self.boundaryChars;
  var boundaryLength = self.boundary.length;
  var boundaryEnd = boundaryLength - 1;
  var bufferLength = buffer.length;
  var c;
  var cl;
  // boundary = \r\n------XXXXXXXXXXXXXX
  // 全过程对 buffer 进行循环，所以不存在任何文件的格式问题，如果是对 buffer.toString 后的字符串进行循环，是无法判断收集到的文件是何种格式的，这点是核心关键
  // 所以我们只能对 buffer 进行循环，在循环中根据 buffer 字节码判断 : - LF RF 等符号来判断到底循环到哪个步骤，这是过滤难点
  for (i = 0; i < len; i++) {
    c = buffer[i];
    switch (state) {
      case START:
        // 记住 index 永远最大只是 boundary 的长度
        index = 0;
        state = START_BOUNDARY;
        /* falls through */
      case START_BOUNDARY:
        console.log(`${i}, ${c} === ${boundary[index+2]}, ${index}, ${boundary[index]}`)
        if (index === boundaryLength - 2 && c === HYPHEN) {
          index = 1;
          state = CLOSE_BOUNDARY;
          break;
        } else if (index === boundaryLength - 2) {
          // 如果此时 c 对应 boundary 倒数第二位是换行符 CR CR => 13(buffer 中回车符 \r 是13)
          if (c !== CR) return self.handleError(createError(400, 'Expected CR Received ' + c));
          index++;
          break;
        } else if (index === boundaryLength - 1) {
          // 如果 c 对应 boundary 最后一位不是换行符 LF LF => 10(buffer 中换行符 \n 是10)
          if (c !== LF) return self.handleError(createError(400, 'Expected LF Received ' + c));
          index = 0;
          self.onParsePartBegin();
          state = HEADER_FIELD_START;
          break;
        }

        if (c !== boundary[index+2]) index = -2;
        if (c === boundary[index+2]) index++;
        break;
      case HEADER_FIELD_START:
        // 此时这里已经是 Conteng--Disposition 的开头了
        state = HEADER_FIELD;
        // 记录此时 boundary 换行后的第一个位置下标
        self.headerFieldMark = i;
        // 将 index 重置，在记录 data 值的时候会用到
        index = 0;
        /* falls through */
      case HEADER_FIELD:
        // 此时如果直接遇到开头即为回车符的情况，那么肯定是表单上传的第一个表单信息的头部以获取完毕，在下一行一定会是此表单第一个 data 的值
        if (c === CR) {
          self.headerFieldMark = null;
          state = HEADERS_ALMOST_DONE;
          break;
        }

        index++;
        if (c === HYPHEN) break;

        // 如果是当前 buffer 循环到 58 => 冒号时
        if (c === COLON) {
          if (index === 1) {
            // empty header field
            self.handleError(createError(400, 'Empty header field'));
            return;
          }
          // 截取了头部的 key，第一个是 Content-Disposition
          self.onParseHeaderField(buffer.slice(self.headerFieldMark, i));
          self.headerFieldMark = null;
          state = HEADER_VALUE_START;
          break;
        }

        cl = lower(c);
        if (cl < A || cl > Z) {
          self.handleError(createError(400, 'Expected alphabetic character, received ' + c));
          return;
        }
        break;
      case HEADER_VALUE_START:
        if (c === SPACE) break;
        // 记录冒号空格后的位置，即 value 值的第一个位置
        self.headerValueMark = i;
        state = HEADER_VALUE;
        /* falls through */
      case HEADER_VALUE:
        // 当到达回车符时，开始对本行的头部 key 对应的 value 进行过滤操作
        if (c === CR) {
          // 截取 value 并赋值给 form.headerValue
          self.onParseHeaderValue(buffer.slice(self.headerValueMark, i));
          self.headerValueMark = null;
          // 在 form.partHeaders 对象中记录对应 key value，并在其中过滤 Content-Disposition 中的 name 与 filename 字段出来为独立的 key value 等
          // 最后重置 headerField 与 headerValue 等待接受下一次循环过滤
          self.onParseHeaderEnd();
          state = HEADER_VALUE_ALMOST_DONE;
        }
        break;
      case HEADER_VALUE_ALMOST_DONE:
        // 不出意外，此时一定是会到换行符的，每行结尾不论是 windows、Unix、macOs 任何操作系统都会是换行符 LF，此时重置 buffer 的循环状态，获取下一行的头部 key
        if (c !== LF) return self.handleError(createError(400, 'Expected LF Received ' + c));
        state = HEADER_FIELD_START;
        break;
      case HEADERS_ALMOST_DONE:
        // 回车符后紧跟换行符
        if (c !== LF) return self.handleError(createError(400, 'Expected LF Received ' + c));
        var err = self.onParseHeadersEnd(i + 1);
        if (err) return self.handleError(err);
        state = PART_DATA_START;
        break;
      case PART_DATA_START:
        state = PART_DATA;
        // 记录表单 data 值开头的当前位置
        self.partDataMark = i;
        /* falls through */
      case PART_DATA:
        // 开始过滤每个表单的 data 值
        prevIndex = index;

        // 在 HEADER_FIELD_START 阶段，index 已重置为 0，所以表单每个头部信息过滤完毕后开始过滤 data 值时一定会先时 0
        if (index === 0) {
          // 使用 boyer-moore 字符串算法安全的跳过没有 boundadry 的数据行
          // boyer-moore derrived algorithm to safely skip non-boundary data
          i += boundaryEnd;
          while (i < bufferLength && !(buffer[i] in boundaryChars)) {
            i += boundaryLength;
          }
          i -= boundaryEnd;
          c = buffer[i];
        }

        if (index < boundaryLength) {
          // 当完全跳过没有 boundary 的数据后，此时 buffer 已经轮循到下一个 boundary 时，即下一个表单头，此时已经计算出 data 需要截取的终点
          // 由于表单上传的最后也是以分隔符 boundary 结束的，所以我们再次用 index 记录何时才到最后整个表单数据的结尾
          if (boundary[index] === c) {
            if (index === 0) {
              // 开始截取 buffer 并流式写入 data
              self.onParsePartData(buffer.slice(self.partDataMark, i));
              self.partDataMark = null;
            }
            index++;
          } else {
            index = 0;
          }
        } else if (index === boundaryLength) {
          index++;
          // 如果一段完毕后是回车府而不是 HYPERN => '-', 则代表表单数据还没到最后一个结尾分隔符，此时我们依照步骤继续下一个头的过滤
          // 如果到达了最后一行的分隔符位置，则开始进行收尾状态 CLOSE_BOUNDARY
          // 此为最后一行的一个例子 -----WebKitFormBoundarynvsHLTGB18H2f0ib--，没到最后一行，最后是不会有 '--' 这 2 个 HYPHEN 的
          if (c === CR) {
            // CR = part boundary
            self.partBoundaryFlag = true;
          } else if (c === HYPHEN) {
            index = 1;
            state = CLOSE_BOUNDARY;
            break;
          } else {
            index = 0;
          }
        } else if (index - 1 === boundaryLength)  {
          if (self.partBoundaryFlag) {
            index = 0;
            if (c === LF) {
              self.partBoundaryFlag = false;
              self.onParsePartEnd();
              self.onParsePartBegin();
              state = HEADER_FIELD_START;
              break;
            }
          } else {
            index = 0;
          }
        }

        if (index > 0) {
          // when matching a possible boundary, keep a lookbehind reference
          // in case it turns out to be a false lead
          lookbehind[index-1] = c;
        } else if (prevIndex > 0) {
          // if our boundary turned out to be rubbish, the captured lookbehind
          // belongs to partData
          self.onParsePartData(lookbehind.slice(0, prevIndex));
          prevIndex = 0;
          self.partDataMark = i;

          // reconsider the current character even so it interrupted the sequence
          // it could be the beginning of a new sequence
          i--;
        }

        break;
      case CLOSE_BOUNDARY:
        if (c !== HYPHEN) return self.handleError(createError(400, 'Expected HYPHEN Received ' + c));
        if (index === 1) {
          self.onParsePartEnd();
          state = END;
        } else if (index > 1) {
          return self.handleError(new Error("Parser has invalid state."));
        }
        index++;
        break;
      case END:
        break;
      default:
        self.handleError(new Error("Parser has invalid state."));
        return;
    }
  }

  if (self.headerFieldMark != null) {
    self.onParseHeaderField(buffer.slice(self.headerFieldMark));
    self.headerFieldMark = 0;
  }
  if (self.headerValueMark != null) {
    self.onParseHeaderValue(buffer.slice(self.headerValueMark));
    self.headerValueMark = 0;
  }
  if (self.partDataMark != null) {
    self.onParsePartData(buffer.slice(self.partDataMark));
    self.partDataMark = 0;
  }

  self.index = index;
  self.state = state;

  self.bytesReceived += buffer.length;
  self.emit('progress', self.bytesReceived, self.bytesExpected);

  if (self.backpressure) {
    self.writeCbs.push(cb);
  } else {
    cb();
  }
};

Form.prototype.onParsePartBegin = function() {
  clearPartVars(this);
}

Form.prototype.onParseHeaderField = function(b) {
  this.headerField += this.headerFieldDecoder.write(b);
}

Form.prototype.onParseHeaderValue = function(b) {
  this.headerValue += this.headerValueDecoder.write(b);
}

Form.prototype.onParseHeaderEnd = function() {
  this.headerField = this.headerField.toLowerCase();
  this.partHeaders[this.headerField] = this.headerValue;

  var m;
  if (this.headerField === 'content-disposition') {
    if (m = this.headerValue.match(/\bname="([^"]+)"/i)) {
      this.partName = m[1];
    }
    this.partFilename = parseFilename(this.headerValue);
  } else if (this.headerField === 'content-transfer-encoding') {
    this.partTransferEncoding = this.headerValue.toLowerCase();
  }

  this.headerFieldDecoder = new StringDecoder(this.encoding);
  this.headerField = '';
  this.headerValueDecoder = new StringDecoder(this.encoding);
  this.headerValue = '';
}

Form.prototype.onParsePartData = function(b) {
  if (this.partTransferEncoding === 'base64') {
    this.backpressure = ! this.destStream.write(b.toString('ascii'), 'base64');
  } else {
    this.backpressure = ! this.destStream.write(b);
  }
}

Form.prototype.onParsePartEnd = function() {
  if (this.destStream) {
    flushWriteCbs(this);
    var s = this.destStream;
    process.nextTick(function() {
      s.end();
    });
  }
  clearPartVars(this);
}

Form.prototype.onParseHeadersEnd = function(offset) {
  var self = this;
  switch(self.partTransferEncoding){
    case 'binary':
    case '7bit':
    case '8bit':
      self.partTransferEncoding = 'binary';
      break;

    case 'base64': break;
    default:
      return createError(400, 'unknown transfer-encoding: ' + self.partTransferEncoding);
  }

  self.totalFieldCount += 1;
  if (self.totalFieldCount > self.maxFields) {
    return createError(413, 'maxFields ' + self.maxFields + ' exceeded.');
  }

  self.destStream = new stream.PassThrough();
  self.destStream.on('drain', function() {
    flushWriteCbs(self);
  });
  self.destStream.headers = self.partHeaders;
  self.destStream.name = self.partName;
  self.destStream.filename = self.partFilename;
  self.destStream.byteOffset = self.bytesReceived + offset;
  var partContentLength = self.destStream.headers['content-length'];
  self.destStream.byteCount = partContentLength ? parseInt(partContentLength, 10) :
    self.bytesExpected ? (self.bytesExpected - self.destStream.byteOffset -
      self.boundary.length - LAST_BOUNDARY_SUFFIX_LEN) :
    undefined;

  if (self.destStream.filename == null && self.autoFields) {
    handleField(self, self.destStream);
  } else if (self.destStream.filename != null && self.autoFiles) {
    handleFile(self, self.destStream);
  } else {
    handlePart(self, self.destStream);
  }
}

function flushWriteCbs(self) {
  self.writeCbs.forEach(function(cb) {
    process.nextTick(cb);
  });
  self.writeCbs = [];
  self.backpressure = false;
}

function getBytesExpected(headers) {
  var contentLength = headers['content-length'];
  if (contentLength) {
    return parseInt(contentLength, 10);
  } else if (headers['transfer-encoding'] == null) {
    return 0;
  } else {
    return null;
  }
}

function beginFlush(self) {
  self.flushing += 1;
}

function endFlush(self) {
  self.flushing -= 1;

  if (self.flushing < 0) {
    // if this happens this is a critical bug in multiparty and this stack trace
    // will help us figure it out.
    self.handleError(new Error("unexpected endFlush"));
    return;
  }

  maybeClose(self);
}

function maybeClose(self) {
  if (self.flushing > 0 || self.error) return;

  // go through the emit queue in case any field, file, or part events are
  // waiting to be emitted
  holdEmitQueue(self)(function() {
    // nextTick because the user is listening to part 'end' events and we are
    // using part 'end' events to decide when to emit 'close'. we add our 'end'
    // handler before the user gets a chance to add theirs. So we make sure
    // their 'end' event fires before we emit the 'close' event.
    // this is covered by test/standalone/test-issue-36
    process.nextTick(function() {
      self.emit('close');
    });
  });
}

function cleanupOpenFiles(self) {
  self.openedFiles.forEach(function(internalFile) {
    // since fd slicer autoClose is true, destroying the only write stream
    // is guaranteed by the API to close the fd
    internalFile.ws.destroy();

    fs.unlink(internalFile.publicFile.path, function(err) {
      if (err) self.handleError(err);
    });
  });
  self.openedFiles = [];
}

function holdEmitQueue(self, eventEmitter) {
  var item = {cb: null, ee: eventEmitter, err: null};
  self.emitQueue.push(item);
  return function(cb) {
    item.cb = cb;
    flushEmitQueue(self);
  };
}

function errorEventQueue(self, eventEmitter, err) {
  var items = self.emitQueue.filter(function (item) {
    return item.ee === eventEmitter;
  });

  if (items.length === 0) {
    eventEmitter.emit('error', err);
    return;
  }

  items.forEach(function (item) {
    item.err = err;
  });
}

function flushEmitQueue(self) {
  while (self.emitQueue.length > 0 && self.emitQueue[0].cb) {
    var item = self.emitQueue.shift();

    // invoke the callback
    item.cb();

    if (item.err) {
      // emit the delayed error
      item.ee.emit('error', item.err);
    }
  }
}

function handlePart(self, partStream) {
  beginFlush(self);
  var emitAndReleaseHold = holdEmitQueue(self, partStream);
  partStream.on('end', function() {
    endFlush(self);
  });
  emitAndReleaseHold(function() {
    self.emit('part', partStream);
  });
}

function handleFile(self, fileStream) {
  if (self.error) return;
  var publicFile = {
    fieldName: fileStream.name,
    originalFilename: fileStream.filename,
    path: uploadPath(self.uploadDir, fileStream.filename),
    headers: fileStream.headers,
    size: 0
  };
  var internalFile = {
    publicFile: publicFile,
    ws: null
  };
  beginFlush(self); // flush to write stream
  var emitAndReleaseHold = holdEmitQueue(self, fileStream);
  fileStream.on('error', function(err) {
    self.handleError(err);
  });
  fs.open(publicFile.path, 'wx', function(err, fd) {
    if (err) return self.handleError(err);
    var slicer = fdSlicer.createFromFd(fd, {autoClose: true});

    // end option here guarantees that no more than that amount will be written
    // or else an error will be emitted
    internalFile.ws = slicer.createWriteStream({end: self.maxFilesSize - self.totalFileSize});

    // if an error ocurred while we were waiting for fs.open we handle that
    // cleanup now
    self.openedFiles.push(internalFile);
    if (self.error) return cleanupOpenFiles(self);

    var prevByteCount = 0;
    internalFile.ws.on('error', function(err) {
      self.handleError(err.code === 'ETOOBIG'
        ? createError(413, err.message, { code: err.code })
        : err)
    });
    internalFile.ws.on('progress', function() {
      publicFile.size = internalFile.ws.bytesWritten;
      var delta = publicFile.size - prevByteCount;
      self.totalFileSize += delta;
      prevByteCount = publicFile.size;
    });
    slicer.on('close', function() {
      if (self.error) return;
      emitAndReleaseHold(function() {
        self.emit('file', fileStream.name, publicFile);
      });
      endFlush(self);
    });
    fileStream.pipe(internalFile.ws);
  });
}

function handleField(self, fieldStream) {
  var value = '';
  var decoder = new StringDecoder(self.encoding);

  beginFlush(self);
  var emitAndReleaseHold = holdEmitQueue(self, fieldStream);
  fieldStream.on('error', function(err) {
    self.handleError(err);
  });
  fieldStream.on('readable', function() {
    var buffer = fieldStream.read();
    if (!buffer) return;

    self.totalFieldSize += buffer.length;
    if (self.totalFieldSize > self.maxFieldsSize) {
      self.handleError(createError(413, 'maxFieldsSize ' + self.maxFieldsSize + ' exceeded'));
      return;
    }
    value += decoder.write(buffer);
  });

  fieldStream.on('end', function() {
    emitAndReleaseHold(function() {
      self.emit('field', fieldStream.name, value);
    });
    endFlush(self);
  });
}

function clearPartVars(self) {
  self.partHeaders = {};
  self.partName = null;
  self.partFilename = null;
  self.partTransferEncoding = 'binary';
  self.destStream = null;

  self.headerFieldDecoder = new StringDecoder(self.encoding);
  self.headerField = "";
  self.headerValueDecoder = new StringDecoder(self.encoding);
  self.headerValue = "";
}

function setUpParser(self, boundary) {
  self.boundary = Buffer.alloc(boundary.length + 4)
  // buf.write(string[, offset[, length]][, encoding])
  self.boundary.write('\r\n--', 0, boundary.length + 4, 'ascii');
  self.boundary.write(boundary, 4, boundary.length, 'ascii');
  // self.boundary = ------WebkitXXXXXXXXXXXXXXXXXXXX
  self.lookbehind = Buffer.alloc(self.boundary.length + 8)
  self.state = START;
  self.boundaryChars = {};
  // 去重 boundary 缓冲块
  for (var i = 0; i < self.boundary.length; i++) {
    self.boundaryChars[self.boundary[i]] = true;
  }
  self.index = null;
  self.partBoundaryFlag = false;

  beginFlush(self);
  self.on('finish', function() {
    if (self.state !== END) {
      self.handleError(createError(400, 'stream ended unexpectedly'));
    }
    endFlush(self);
  });
}

function uploadPath(baseDir, filename) {
  var ext = path.extname(filename).replace(FILE_EXT_RE, '$1');
  var name = uid.sync(18) + ext
  return path.join(baseDir, name);
}

function parseFilename(headerValue) {
  var m = headerValue.match(/\bfilename="(.*?)"($|; )/i);
  if (!m) {
    m = headerValue.match(/\bfilename\*=utf-8\'\'(.*?)($|; )/i);
    if (m) {
      m[1] = decodeURI(m[1]);
    }
    else {
      return;
    }
  }

  var filename = m[1];
  filename = filename.replace(/%22|\\"/g, '"');
  filename = filename.replace(/&#([\d]{4});/g, function(m, code) {
    return String.fromCharCode(code);
  });
  return filename.substr(filename.lastIndexOf('\\') + 1);
}

function lower(c) {
  return c | 0x20;
}
