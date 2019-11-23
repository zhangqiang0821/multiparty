写这篇文章的起因是我在尝试使用 Node 的原生模块去接收表单上传的数据并分割过滤表单文件与数据时，由于一开始是对可写流拼接 buffer 转的字符串进行轮询，导致只能接收文件格式为 txt 的文本文件，在接收图片或其他文件格式时却发生了写入后无法打开的情况，而 txt 文件的中文也会乱码，这是因为 buffer 在转字符串时默认为 utf8 格式，进行写入后，无法识别中文，而其他文件格式在无法判别 encoding 的情况下，在编码的转换截取中极其容易被截漏或截错。

在网上根本没有一篇真正告诉你怎么用 Node 原生代码去处理表单的过程，即使有的也都是错的，我是都测试过的，因为它们的原理大都跟我一样都是对字符串进行轮询，这是错误的处理方式。

所以经过对各大中间件进行追本溯源的过程后，我找到了专门用来处理表单(MIME 为 multipart/form-data)的中间件 [multiparty](https://github.com/pillarjs/multiparty)，遂决定看懂后一定要自己过滤一遍并写出文章给其他跟我有类似问题的童鞋参考。

下面放上解析

本中间件的构造函数 `Form` 与直接暴漏的过滤函数 `Form.prototype.parse` 都十分简单，我不在此赘述，因为这个 2 个环节非常简单，稍微有点基础的同学都应该能看懂，重要的是我下面分析的 `Form.prototype._write` 方法，这是一个对可写流内部传入底层写入方法的一个重写，在包内你不会找到任何一个地方有调用这个方法，所以大家一定要看 Node 文档 `Stream` 模块中对 `writable._write` 方法的描述

![writable._write](https://img-blog.csdnimg.cn/20181202192824354.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3lvbG8wOTI3,size_16,color_FFFFFF,t_70)

大家一定要注意我标记的三行解释，它充分的告诉了我们，这个方法是内部方法，只要我们利用继承，将 `From` 的原型继承到 `Stream.Writable ` 中即可实现，下面放上我对 `Form.prototype._write` 的整段分析，而整个中间件的核心也就是这个方法了，其他多为此方法的辅助函数

首先童鞋们一定要注意源码 line:50 位置的``util.inherits(Form, stream.Writable)``
大家看到这个方法可能会找不到此包在哪里调用，其实这关键的操作在于包一旦引入便进行了 Form 继承 写入流 stream.Writable 的操作，原本可写流的内部方法 writable._write 被 Form 原型中的 _write 先传入底层

再次实例化 Form 调用 write 时将会使用的底层函数会是我们写的 ``Form.prototype._write``，**由此我们不但使 Form 的实例化对象具有写入流，并且还重写了写入的逻辑**

达到每次 transform 流都会调用我们在这里重写的 _write 方法，在 parse 方法的最后调用 req.pipe(self) 时由管道流将 req 写入 Form 实例时触发调用
```js
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
```

针对不知道为什么 pipe 会触发 writable._write 的同学，我在这里清楚的解释下
由于 pipe 的原理实际就是监测 Readable 的 data 事件，然后在其中不停调用 Writable.write(chunk)，如下简单实现 Readable.prototype.pipe(writable, options)
```js
  readable.on('data', (chunk) => {
    // 当发生背压时（即当前可用内存已写满此类情况）
    if (writable.write(chunk) === false) {
      readable.pause()
    }
  })

  // drain 事件在写入流再次可继续写入时触发，此时将可读流恢复读取即可再次触发 data 事件去 write
  writable.on('drain', () => {
    readable.resume()
  })
```
由上述简单实现我们已经看到了在 pipe 管道流的过程中，我们是不断的在调用 write 的，而 write 的底层实现就是 _write，所以我们改写的 _write 就会被调用啦。

最后当 pipe 读写完毕后即 _write 全部调用完后 writable 会源码会进行以下顺序触发调用
1. 触发 finish 事件从而使 setUpParser 函数中监听 finish 的函数发生调用
2. 紧接着调用 endFlush => maybeClose => holdEmitQueue闭包调用
3. 下一事件循环触发 close 事件 => 由此触发 Form.prototype.parse 由回调时监听的 close 事件，而将表单的 field 与 file 都注入使用者的回调内

下面是我打印的调用顺序，由于 pipe 是一个基于事件循环（event loop）的异步过程，所以第一次 pipe 完一定会是会在下一个事件循环队列，所以我们必须跳过第一次的主进程循环队列的 macro task 所以，下面是我的 log 过程及结果

###### 插入标记
![parse 中的插入输出](https://img-blog.csdnimg.cn/20181206211209656.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3lvbG8wOTI3,size_16,color_FFFFFF,t_70)
![_write 中的插入输出](https://img-blog.csdnimg.cn/2018120621124293.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3lvbG8wOTI3,size_16,color_FFFFFF,t_70)
###### 输出结果
![在这里插入图片描述](https://img-blog.csdnimg.cn/20181206211353631.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3lvbG8wOTI3,size_16,color_FFFFFF,t_70)

这就是最好的证明了～


大家最好是在 IDE 中对着源码看会比较容易看点，如果大家像我一样一遍看不懂就看两遍，不行就三遍，因为我就是这么做的= =。。。

如文中有错误的知识描述，大家告诉我后，我会立刻更改。
