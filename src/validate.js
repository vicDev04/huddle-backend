import { bad } from './errors.js';

export const AVATAR_BUILDER = /^L(\.[0-9a-z]{1,2}){13,15}$/;
export const AVATAR_PRESET = /^a(0[1-9]|1[0-8])$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f]/g;

export const isAvatar = (v) => typeof v === 'string' && v.length <= 64 && (AVATAR_BUILDER.test(v) || AVATAR_PRESET.test(v));

export function avatar(v) {
  if (!isAvatar(v)) throw bad('INVALID_AVATAR', 'Avatar must be a builder code or a preset (a01-a18)');
  return v;
}
export function color(v) {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw bad('INVALID_COLOR', 'Color must look like #7c5cff');
  return v;
}
export function displayName(v) {
  if (typeof v !== 'string') throw bad('INVALID_DISPLAY_NAME', 'Display name is required');
  const s = v.trim();
  if (s.length < 1 || s.length > 20 || CONTROL.test(s)) throw bad('INVALID_DISPLAY_NAME', 'Display name must be 1-20 characters');
  return s;
}
export function str(v, field) {
  if (typeof v !== 'string') throw bad('VALIDATION_ERROR', `${field} is required`);
  return v;
}
export function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw bad('VALIDATION_ERROR', 'JSON body required');
  return req.body;
}

// Strip control chars, trim, check length and profanity.
const BLOCKED = ['caralho', 'foda', 'fodas', 'foder', 'fodase', 'puta', 'putas', 'merda', 'cona', 'pica', 'paneleiro', 'cabrao', 'fdp', 'crl',
  'fuck', 'fucking', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'whore'];
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function cleanText(v, min, max, field = 'text') {
  if (typeof v !== 'string') throw bad('VALIDATION_ERROR', `${field} is required`);
  const s = v.replace(CONTROL_G, '').trim();
  if (s.length < min || s.length > max) throw bad('INVALID_TEXT', `${field} must be ${min}-${max} characters`);
  const words = norm(s).split(/[^a-z0-9]+/);
  if (words.some((w) => BLOCKED.includes(w))) throw bad('BLOCKED_TEXT', 'Please keep it friendly');
  return s;
}
