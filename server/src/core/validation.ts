import { z } from 'zod';
import { CHANNEL_TYPES } from '../types.js';

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Email is required')
  .max(254, 'Email must be 254 characters or less')
  .email('Email must be a valid address')
  .transform((value) => value.toLowerCase());

export const passwordSchema = (minLength: number) =>
  z
    .string()
    .min(minLength, `Password must be at least ${minLength} characters long`)
    .max(128, 'Password must be 128 characters or less');

export const displayNameSchema = z.string().trim().min(1, 'Display name is required').max(50);

export const channelNameSchema = z
  .string()
  .trim()
  .min(2, 'Channel name must be at least 2 characters')
  .max(32, 'Channel name must be 32 characters or less')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Channel name can only contain letters, numbers, hyphens, and underscores');

export const channelTypeSchema = z.enum(CHANNEL_TYPES as [string, ...string[]]);

export const idSchema = z.string().trim().min(1).max(128);

export const optionalIdSchema = z
  .union([idSchema, z.null(), z.undefined()])
  .transform((value) => (value ? value : null));

/** Strips control characters except tab/newline and trims. */
export const messageTextSchema = (maxLength: number) =>
  z
    .string()
    .transform((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim())
    .pipe(z.string().min(1, 'Message cannot be empty').max(maxLength, `Message must be ${maxLength} characters or less`));

const permissionEntryInput = z
  .object({
    roles: z.array(z.string()).optional(),
    accounts: z.array(z.string()).optional(),
    allowRoles: z.array(z.string()).optional(),
    allowAccounts: z.array(z.string()).optional(),
  })
  .partial();

export const permissionsInputSchema = z
  .object({
    view: permissionEntryInput.optional(),
    chat: permissionEntryInput.optional(),
    voice: permissionEntryInput.optional(),
    stream: permissionEntryInput.optional(),
    manage: permissionEntryInput.optional(),
    allowedStreamers: z.array(z.string()).optional(),
    superuserOnly: z.boolean().optional(),
  })
  .partial();

export type PermissionsInput = z.infer<typeof permissionsInputSchema>;

export const optionalUrlSchema = z
  .union([z.string().trim().max(2048), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

export const optionalTextSchema = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((value) => (value ? value : null));
