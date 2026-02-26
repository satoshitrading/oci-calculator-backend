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
  await app.listen(port);
  console.log(`OCI Price Calculator backend listening on port ${port}`);
}
bootstrap();
