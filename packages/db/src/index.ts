import { PrismaClient } from '@prisma/client';
import { PrismaStore } from './prisma-store.ts';

export { PrismaStore };
export const createPrisma = () => new PrismaClient();
export const createStore = (db: PrismaClient = new PrismaClient()) => new PrismaStore(db);
