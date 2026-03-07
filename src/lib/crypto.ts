import { crypto } from "bun";

const ENCRYPTION_KEY = process.env.BIOMETRIC_ENCRYPTION_KEY || "your-32-char-secret-key-12345678";

/**
 * Encrypt biometric template using AES-256-GCM
 */
export async function encryptTemplate(template: string) {
  const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
  const key = Buffer.from(ENCRYPTION_KEY, 'utf-8');
  
  const cipher = require('node:crypto').createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(template, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const tag = cipher.getAuthTag().toString('base64');

  return {
    encrypted,
    iv: iv.toString('base64'),
    tag
  };
}

/**
 * Decrypt biometric template using AES-256-GCM
 */
export async function decryptTemplate(encrypted: string, ivBase64: string, tagBase64: string) {
  const iv = Buffer.from(ivBase64, 'base64');
  const tag = Buffer.from(tagBase64, 'base64');
  const key = Buffer.from(ENCRYPTION_KEY, 'utf-8');
  
  const decipher = require('node:crypto').createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
