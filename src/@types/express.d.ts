import { Multer } from 'multer';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      file?: Multer.File;
    }
  }
}
