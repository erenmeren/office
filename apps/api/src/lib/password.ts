import argon2 from 'argon2';

export const hashPassword = (p: string) => argon2.hash(p);
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p);
