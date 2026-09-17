import { Throttle } from "@nestjs/throttler";

/**
 * Risk-sensitive per-endpoint limits (per 60s window). The route only selects the
 * named policy; the actual numbers live in validated env config (safe defaults in
 * `env.validation.ts`, tunable via THROTTLE_*_LIMIT). Health probes stay exempt.
 */
export const LoginThrottle = () => Throttle({ login: {} });

export const RegisterThrottle = () => Throttle({ register: {} });

export const ForgotPasswordThrottle = () => Throttle({ forgot: {} });

export const ResendVerificationThrottle = () => Throttle({ resend: {} });

export const ResetPasswordThrottle = () => Throttle({ reset: {} });

export const InvitationThrottle = () => Throttle({ invite: {} });

export const GoogleThrottle = () => Throttle({ google: {} });

export const RefreshThrottle = () => Throttle({ refresh: {} });
