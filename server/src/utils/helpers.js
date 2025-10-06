/**
 * Utility Functions
 * Common helper functions used throughout the application
 */

import crypto from 'crypto';
import { appConfig } from '../config/index.js';

/**
 * Generate a unique ID
 * @param {number} length - Length of the ID (default: 16 characters)
 * @returns {string} Unique hexadecimal ID
 */
export function generateId(length = 16) {
  return crypto.randomBytes(length / 2).toString('hex');
}

/**
 * Generate a secure stream key
 * Format: channelName+24charAlphanumeric
 * @param {string} channelName - Name of the channel
 * @returns {string} Stream key
 */
export function generateStreamKey(channelName) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const length = appConfig.streaming.streamKeyLength;
  let token = '';
  const bytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    token += chars[bytes[i] % chars.length];
  }
  
  return `${channelName}+${token}`;
}

/**
 * Sanitize user input to prevent XSS
 * @param {string} input - User input string
 * @returns {string} Sanitized string
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove < and >
    .slice(0, appConfig.messages.maxMessageLength);
}

/**
 * Validate channel name
 * @param {string} name - Channel name
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateChannelName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Channel name is required' };
  }
  
  const trimmed = name.trim();
  
  if (trimmed.length < 2) {
    return { valid: false, error: 'Channel name must be at least 2 characters' };
  }
  
  if (trimmed.length > appConfig.channels.maxChannelNameLength) {
    return { valid: false, error: `Channel name must be less than ${appConfig.channels.maxChannelNameLength} characters` };
  }
  
  // Only allow alphanumeric, hyphens, and underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { valid: false, error: 'Channel name can only contain letters, numbers, hyphens, and underscores' };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Validate username
 * @param {string} name - Username
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateUsername(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  const trimmed = name.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Email is required' };
  }

  if (trimmed.length > 254) {
    return { valid: false, error: 'Email must be 254 characters or less' };
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(trimmed)) {
    return { valid: false, error: 'Email must be a valid address' };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validate message content
 * @param {string} message - Message text
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateMessage(message) {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message is required' };
  }
  
  const trimmed = message.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }
  
  if (trimmed.length > appConfig.messages.maxMessageLength) {
    return { valid: false, error: `Message must be less than ${appConfig.messages.maxMessageLength} characters` };
  }
  
  return { valid: true, value: sanitizeInput(trimmed) };
}

/**
 * Check if channel type is valid
 * @param {string} type - Channel type
 * @returns {boolean} Valid or not
 */
export function isValidChannelType(type) {
  return ['text', 'voice', 'stream'].includes(type);
}

/**
 * Format error for client
 * @param {string} message - Error message
 * @param {string} code - Error code
 * @returns {Object} Formatted error
 */
export function formatError(message, code = 'ERROR') {
  return {
    error: true,
    message,
    code,
    timestamp: Date.now(),
  };
}

/**
 * Format success response
 * @param {*} data - Response data
 * @param {string} message - Success message
 * @returns {Object} Formatted response
 */
export function formatSuccess(data, message = 'Success') {
  return {
    success: true,
    message,
    data,
    timestamp: Date.now(),
  };
}

/**
 * Rate limiter helper (in-memory)
 * @param {Map} store - Store for tracking requests
 * @param {string} key - Unique identifier (e.g., IP address)
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {boolean} Whether request should be allowed
 */
export function checkRateLimit(store, key, maxRequests, windowMs) {
  const now = Date.now();
  const record = store.get(key) || { count: 0, resetTime: now + windowMs };
  
  // Reset if window has passed
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + windowMs;
  }
  
  record.count++;
  store.set(key, record);
  
  return record.count <= maxRequests;
}

/**
 * Clean up expired rate limit records
 * @param {Map} store - Rate limit store
 */
export function cleanupRateLimitStore(store) {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    if (now > record.resetTime) {
      store.delete(key);
    }
  }
}

/**
 * Get client IP from socket
 * @param {Socket} socket - Socket.IO socket
 * @returns {string} IP address
 */
export function getClientIp(socket) {
  // Cloudflare provides the real client IP in CF-Connecting-IP header
  return socket.handshake.headers['cf-connecting-ip'] ||
         socket.handshake.headers['x-real-ip'] ||
         socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
         socket.handshake.address ||
         'unknown';
}

/**
 * Sleep utility for async operations
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after specified time
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deep clone an object
 * @param {*} obj - Object to clone
 * @returns {*} Cloned object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Remove sensitive data from user object
 * @param {Object} user - User object
 * @returns {Object} Sanitized user object
 */
export function sanitizeUserData(user) {
  const { superuserSecret, password, sessionToken, ...safe } = user || {};
  return safe;
}

export default {
  generateId,
  generateStreamKey,
  sanitizeInput,
  validateChannelName,
  validateUsername,
  validateMessage,
  isValidChannelType,
  formatError,
  formatSuccess,
  checkRateLimit,
  cleanupRateLimitStore,
  getClientIp,
  sleep,
  deepClone,
  sanitizeUserData,
};
