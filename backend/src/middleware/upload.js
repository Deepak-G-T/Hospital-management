const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ApiError = require('../utils/ApiError');
const { uploadDir, maxUploadMb } = require('../config/env');

const REPORT_DIR = path.resolve(__dirname, '../../', uploadDir, 'reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const ALLOWED = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'text/plain': ['.txt'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, REPORT_DIR),
  // Random stored name — the original name is never used on disk (prevents path traversal / overwrite)
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExts = ALLOWED[file.mimetype];
  if (!allowedExts || !allowedExts.includes(ext)) {
    return cb(ApiError.badRequest('Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, TXT, DOC, DOCX'));
  }
  return cb(null, true);
}

const uploadReport = multer({ storage, fileFilter, limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 } }).single('file');

// Verify magic bytes for binary types so a renamed executable cannot pass as a PDF/image
const SIGNATURES = {
  'application/pdf': [Buffer.from('%PDF')],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  'image/webp': [Buffer.from('RIFF')],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  'application/msword': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
};

function verifyFileSignature(req, res, next) {
  if (!req.file) return next(ApiError.badRequest('A file is required'));
  const sigs = SIGNATURES[req.file.mimetype];
  if (!sigs) return next();
  const fd = fs.openSync(req.file.path, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  if (!sigs.some((s) => buf.subarray(0, s.length).equals(s))) {
    fs.unlink(req.file.path, () => {});
    return next(ApiError.badRequest('File content does not match its type'));
  }
  return next();
}

module.exports = { uploadReport, verifyFileSignature, REPORT_DIR };
