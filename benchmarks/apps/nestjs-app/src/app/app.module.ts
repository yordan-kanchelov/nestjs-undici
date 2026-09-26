import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpModule } from './client';

@Module({
  imports: [HttpModule.register({})],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
