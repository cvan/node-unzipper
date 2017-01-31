var Promise = require('bluebird');
var Decrypt = require('../Decrypt');
var PullStream = require('../PullStream');
var NoopStream = require('../NoopStream');
var BufferStream = require('../BufferStream');

var Stream = require('stream');
var binary = require('binary');
var zlib = require('zlib');
var fileStream = require('./fileStream');

// Backwards compatibility for node 0.8
if (!Stream.Writable)
  Stream = require('readable-stream');

module.exports = function unzip(p,_password) {
  var vars, entry = Stream.PassThrough();

  entry.buffer = function() {
    return BufferStream(entry);
  };

  entry.vars = p.pull(30)
    .then(function(data) {
      vars = binary.parse(data)
        .word32lu('signature')
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
      return p.pull(vars.fileNameLength);
    })
    .then(function(fileName) {
      vars.path = fileName.toString('utf8');
      return p.pull(vars.extraFieldLength);
    })
    .then(function(extraField) {
      var extra = binary.parse(extraField)
        .word16lu('signature')
        .word16lu('partsize')
        .word64lu('uncompressedSize')
        .word64lu('compressedSize')
        .word64lu('offset')
        .word64lu('disknum')
        .vars,
        checkEncryption;

      if (vars.compressedSize === 0xffffffff)
        vars.compressedSize = extra.compressedSize;
      
      if (vars.uncompressedSize  === 0xffffffff)
        vars.uncompressedSize= extra.uncompressedSize;
      return vars;
    });

  entry.vars.then(function(vars) {
    if (vars.flags & 0x01) {
      vars.compressedSize -= 12;
      return p.pull(12);
    }  
  })
  .then(function(header) {
      var fileSizeKnown = !(vars.flags & 0x08),
          eof;

      if (fileSizeKnown) {
        entry.size = vars.uncompressedSize;
        eof = vars.compressedSize;
      } else {
        eof = new Buffer(4);
        eof.writeUInt32LE(0x08074b50, 0);
      }

      var stream = entry.source = p.stream(eof);

      if (entry.autodraining)
        return stream.pipe(NoopStream()).pipe(entry);

      if (header) {
        _password = _password || entry.password;
        if (!_password && !entry.autodraining)
          throw new Error('MISSING_PASSWORD');

        var decrypt = Decrypt();

        String(_password).split('').forEach(function(d) {
          decrypt.update(d);
        });

        for (var i=0; i < header.length; i++)
          header[i] = decrypt.decryptByte(header[i]);

        vars.decrypt = decrypt;
        vars.compressedSize -= 12;

        var check = (vars.flags & 0x8) ? (vars.lastModifiedTime >> 8) & 0xff : (vars.crc32 >> 24) & 0xff;
        if (header[11] !== check && !entry.autodraining)
          throw new Error('BAD_PASSWORD');
      }

      var inflater = vars.compressionMethod ? zlib.createInflateRaw() : Stream.PassThrough();

      if (vars.decrypt)
        stream = stream.pipe(vars.decrypt.stream());

      return stream
        .pipe(inflater)
        .on('error',function(err) { entry.emit('error',err);})
        .pipe(entry);
    })
    .catch(function(e) {
      entry.emit('error',e);
    });
  return entry;
};