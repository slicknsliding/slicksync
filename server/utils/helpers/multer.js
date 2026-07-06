/**
 * Centralized multer configuration for file uploads
 */

const multer = require('multer');

/**
 * Create multer instance with standard configuration
 */
function createMulterInstance(options = {}) {
  const defaultOptions = {
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB default limit
    },
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'application/json') {
        cb(null, true);
      } else {
        cb(new Error('Only JSON files are allowed'), false);
      }
    }
  };

  return multer({ ...defaultOptions, ...options });
}

/**
 * Standard multer for JSON file uploads (10MB limit)
 */
const standardUpload = createMulterInstance();

/**
 * Large file upload multer (50MB limit)
 */
const largeFileUpload = createMulterInstance({
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  }
});

/**
 * Multer for any file type (no file filter)
 */
const anyFileUpload = createMulterInstance({
  fileFilter: (req, file, cb) => {
    cb(null, true); // Allow any file type
  }
});

/**
 * Multer for image uploads only (avatars), 5MB limit
 */
const imageUpload = createMulterInstance({
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF, or WEBP images are allowed'), false);
    }
  }
});

module.exports = {
  createMulterInstance,
  standardUpload,
  largeFileUpload,
  anyFileUpload,
  imageUpload
};
