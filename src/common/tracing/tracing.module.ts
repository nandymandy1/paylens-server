import { Module } from "@nestjs/common";
import { ObservabilityModule } from "./observability.module.js";

/**
 * Re-exports ObservabilityModule for backwards compatibility.
 * New code should import ObservabilityModule directly.
 */
@Module({
  imports: [ObservabilityModule],
})
export class TracingModule {}
