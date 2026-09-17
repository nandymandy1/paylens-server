import { Throttle } from "@nestjs/throttler";

/**
 * Risk-sensitive per-endpoint limits (per 60s window, per client). Each route
 * overrides the generous global default with a strict budget for that sensitive
 * operation. Health probes stay exempt via @SkipThrottle.
 */
export const LoginThrottle = () => Throttle({ default: { limit: 10, ttl: 60_000 } });

export const RegisterThrottle = () => Throttle({ default: { limit: 5, ttl: 60_000 } });

export const ForgotPasswordThrottle = () => Throttle({ default: { limit: 5, ttl: 60_000 } });

export const ResendVerificationThrottle = () => Throttle({ default: { limit: 5, ttl: 60_000 } });

export const ResetPasswordThrottle = () => Throttle({ default: { limit: 10, ttl: 60_000 } });

export const InvitationThrottle = () => Throttle({ default: { limit: 10, ttl: 60_000 } });

export const GoogleThrottle = () => Throttle({ default: { limit: 20, ttl: 60_000 } });

export const RefreshThrottle = () => Throttle({ default: { limit: 30, ttl: 60_000 } });
