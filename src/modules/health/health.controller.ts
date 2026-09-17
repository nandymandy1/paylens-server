import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service.js';
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}
  @Get('health') @ApiOperation({ summary: 'Process liveness' }) health() {
    return this.healthService.health();
  }
  @Get('ready')
  @ApiOperation({ summary: 'Critical dependency readiness' })
  async ready() {
    const readiness = await this.healthService.ready();
    if (!readiness.ready) throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
