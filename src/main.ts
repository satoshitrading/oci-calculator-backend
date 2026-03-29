import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  // Global validation pipe — enforces all DTOs across the application
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,       // auto-transform payloads to DTO class instances
      whitelist: true,       // strip unknown properties
      forbidNonWhitelisted: false, // log but don't reject extra fields (file uploads)
    }),
  );

  const port = process.env.PORT || 4000;
  const server = await app.listen(port);
  // Allow long-running requests (e.g. large PDF uploads, collect) so Railway/proxy does not hit 504 first.
  const requestTimeoutMs = 15 * 60 * 1000; // 15 min
  server.timeout = requestTimeoutMs;
  server.keepAliveTimeout = requestTimeoutMs + 1000;
  server.headersTimeout = requestTimeoutMs + 60 * 1000; // slightly above timeout for slow clients
  console.log(`OCI Price Calculator backend listening on port ${port}`);
}
bootstrap();
