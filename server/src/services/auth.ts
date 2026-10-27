import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import { HttpError, type AuthUser } from './common.js';

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-secret-change-me';

export async function login(username: string, password: string) {
  const r = await pool.query('SELECT * FROM users WHERE username = $1 AND active', [username]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Invalid username or password');
  const user: AuthUser = { id: u.id, username: u.username, name: u.name, role: u.role };
  return { token: jwt.sign(user, JWT_SECRET, { expiresIn: '12h' }), user };
}

declare module 'express-serve-static-core' {
  interface Request { user: AuthUser }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const claims = jwt.verify(token, JWT_SECRET) as AuthUser;
    // Role is re-read from the database so role changes take effect immediately.
    const r = await pool.query('SELECT id, username, name, role FROM users WHERE id = $1 AND active', [claims.id]);
    if (!r.rows.length) throw new Error('inactive');
    req.user = r.rows[0];
    next();
  } catch {
    next(new HttpError(401, 'Authentication required'));
  }
}
