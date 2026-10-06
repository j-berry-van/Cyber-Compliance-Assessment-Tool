import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import aiRoutes from './routes/ai.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import recordRoutes from './routes/records.js';
import { requireJson, sessionMiddleware, requireAuth } from './middlewares/auth.js';
import { apiLimiter } from './utils/rateLimiter.js';

export function createApp({ db = null, staticDir = null } = {}) {
  const app = express();
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], fontSrc: ["'self'"],
        objectSrc: ["'none'"], mediaSrc: ["'self'"], frameSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }));
  app.use(cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
  }));
  app.use(express.json({ limit: '25mb' }));
  app.use(cookieParser());

  app.locals.db = db;
  if (db) {
    app.use('/api', requireJson, sessionMiddleware(db));
    app.use('/api/auth', authRoutes(db));
    app.use('/api/users', userRoutes(db));
    app.use('/api/records', recordRoutes(db));
    // import routers are mounted below by later tasks
    app.use('/api/ai', requireAuth); // in multi-user mode the AI proxy requires a session
  }
  app.use('/api/ai', apiLimiter, aiRoutes);

  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile('index.html', { root: staticDir }));
  } else {
    app.get('/', (req, res) => res.json({ message: 'Welcome to the Express server!' }));
  }
  return app;
}
