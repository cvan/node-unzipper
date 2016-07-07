module.exports = Parse.create = Parse;

require("setimmediate");
var Transform = require('readable-stream/transform');
var inherits = require('util').inherits;
var zlib = require('zlib');
var Stream = require('stream');
var binary = require('binary');
var PullStream = require('./PullStream');//require('pullstream');
var MatchStream = require('match-stream');
var Entry = require('./entry');

inherits(Parse, PullStream);

function noopStream() {
  return Stream.Transform({
    transform: (d,e,cb) => cb()
  });
}

function Parse(opts) {
  if (!(this instanceof Parse)) {
    return new Parse(opts);
  }

  this._opts = opts || { verbose: false };
  this._hasEntryListener = false;

  PullStream.call(this, this._opts);
  this.on('finish',() => this.emit('close')) ;
  this._readRecord();
}

Parse.prototype._readRecord = function () {
  this.pull(4).then(data => {
    if (data.length === 0)
      return;

    var signature = data.readUInt32LE(0);
    if (signature === 0x04034b50)
      this._readFile();
    else if (signature === 0x02014b50)
      this._readCentralDirectoryFileHeader();
    else if (signature === 0x06054b50)
      this._readEndOfCentralDirectoryRecord();
    else 
      this.emit('error', Error('invalid signature: 0x' + signature.toString(16)));
  });
};

Parse.prototype._readFile = function () {
  this.pull(26).then(data => {
    var vars = binary.parse(data)
      .word16lu('versionsNeededToExtract')
      .word16lu('flags')
      .word16lu('compressionMethod')
      .word16lu('lastModifiedTime')
      .word16lu('lastModifiedDate')
      .word32lu('crc32')
      .word32lu('compressedSize')
      .word32lu('uncompressedSize')
      .word16lu('fileNameLength')
      .word16lu('extraFieldLength')
      .vars;

    return this.pull(vars.fileNameLength).then(fileName => {
      fileName = fileName.toString('utf8');
      var entry = Stream.PassThrough();
      entry.autodrain = () => this.pipe(noopStream());
      entry.path = fileName;
      entry.props = {};
      entry.props.path = fileName;
      entry.type = (vars.compressedSize === 0 && /[\/\\]$/.test(fileName)) ? 'Directory' : 'File';

      if (this._opts.verbose) {
        if (entry.type === 'Directory') {
          console.log('   creating:', fileName);
        } else if (entry.type === 'File') {
          if (vars.compressionMethod === 0) {
            console.log(' extracting:', fileName);
          } else {
            console.log('  inflating:', fileName);
          }
        }
      }

      var hasEntryListener = this._hasEntryListener;
      this.emit('entry', entry);
      
      this.pull(vars.extraFieldLength).then(extraField => {
        var fileSizeKnown = !(vars.flags & 0x08);

        var inflater = vars.compressionMethod ? zlib.createInflateRaw() : Stream.PassThrough();
        if (!hasEntryListener)
          inflater = noopStream();

        if (fileSizeKnown) {
          entry.size = vars.uncompressedSize;
          this.stream(vars.compressedSize)
            .pipe(inflater)
            .on('error', e => this.emit('error',err))
            .pipe(entry)
            .on('finish', () => this._readRecord());
        } else {
          // TODO - allow pullstream to match
          var descriptorSig = new Buffer(4);
          descriptorSig.writeUInt32LE(0x08074b50, 0);

          var matchStream = new MatchStream({ pattern: descriptorSig }, function (buf, matched, extra) {
            if (hasEntryListener) {
              if (!matched) {
                return this.push(buf);
              }
              this.push(buf);
            }
            setImmediate(function() {
              this.unpipe();
              this.prepend(extra);
              this._processDataDescriptor(entry);
            });
            return this.push(null);
          });

          this.pipe(matchStream);
          if (hasEntryListener) {
            matchStream.pipe(inflater).pipe(entry);
          }
        }
      });
    });
  });
};

Parse.prototype._processDataDescriptor = function (entry) {
  this.pull(16).then(data => {
    var vars = binary.parse(data)
      .word32lu('dataDescriptorSignature')
      .word32lu('crc32')
      .word32lu('compressedSize')
      .word32lu('uncompressedSize')
      .vars;

    entry.size = vars.uncompressedSize;
    this._readRecord();
  });
};

Parse.prototype._readCentralDirectoryFileHeader = function () {
  this.pull(42).then(data => {
    
    var vars = binary.parse(data)
      .word16lu('versionMadeBy')
      .word16lu('versionsNeededToExtract')
      .word16lu('flags')
      .word16lu('compressionMethod')
      .word16lu('lastModifiedTime')
      .word16lu('lastModifiedDate')
      .word32lu('crc32')
      .word32lu('compressedSize')
      .word32lu('uncompressedSize')
      .word16lu('fileNameLength')
      .word16lu('extraFieldLength')
      .word16lu('fileCommentLength')
      .word16lu('diskNumber')
      .word16lu('internalFileAttributes')
      .word32lu('externalFileAttributes')
      .word32lu('offsetToLocalFileHeader')
      .vars;

    return this.pull(vars.fileNameLength).then(fileName => {
      
      fileName = fileName.toString('utf8');

      this.pull(vars.extraFieldLength).then(extraField => {
        this.pull(vars.fileCommentLength).then(fileComment => {
          return this._readRecord();
        });
      });
    });
  });
};

Parse.prototype._readEndOfCentralDirectoryRecord = function () {
  this.pull(18).then(data => {
    
    var vars = binary.parse(data)
      .word16lu('diskNumber')
      .word16lu('diskStart')
      .word16lu('numberOfRecordsOnDisk')
      .word16lu('numberOfRecords')
      .word32lu('sizeOfCentralDirectory')
      .word32lu('offsetToStartOfCentralDirectory')
      .word16lu('commentLength')
      .vars;

    if (vars.commentLength) {
        this.pull(vars.commentLength).then(comment => {
          comment = comment.toString('utf8');
          return this.end();
        });
    } else {
      this.end();
    }
  });
};

Parse.prototype.addListener = function(type, listener) {
  if ('entry' === type) {
    this._hasEntryListener = true;
  }
  return Transform.prototype.addListener.call(this, type, listener);
};

Parse.prototype.on = Parse.prototype.addListener;
