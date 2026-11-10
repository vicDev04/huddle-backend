import jwt from 'jsonwebtoken';
export const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');
export const signToken = (userId) => jwt.sign({ sub: userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' });
export const verifyToken = (tok) => jwt.verify(tok, JWT_SECRET, { algorithms: ['HS256'] }).sub;
