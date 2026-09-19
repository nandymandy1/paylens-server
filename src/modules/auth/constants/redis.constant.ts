export const ROTATE_SCRIPT = `
local data = redis.call("GET", KEYS[1])
if not data then
  return 0
end
local ok, record = pcall(cjson.decode, data)
if not ok then
  return -2
end
if record.refreshTokenHash ~= ARGV[1] then
  return -1
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return 0
end
record.refreshTokenHash = ARGV[2]
record.lastRefreshedAt = ARGV[3]
redis.call("SET", KEYS[1], cjson.encode(record), "PX", ttl)
return 1
`;

export const CONSUME_OAUTH_STATE_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value then
  redis.call("DEL", KEYS[1])
end
return value
`;

/**
 * Atomic session registration with rollback block check (SEED-R1 closure).
 * KEYS[1] = session key, KEYS[2] = user-sessions index, KEYS[3] = session-block key.
 * ARGV[1] = session record JSON, ARGV[2] = session id, ARGV[3] = TTL seconds.
 * Either the block wins (BLOCKED, nothing written) or the session wins (OK).
 */
export const CREATE_SESSION_SCRIPT = `
local blocked = redis.call("EXISTS", KEYS[3])
if blocked == 1 then
  return "BLOCKED"
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
redis.call("SADD", KEYS[2], ARGV[2])
redis.call("EXPIRE", KEYS[2], ARGV[3])
return "OK"
`;

export const SWITCH_ORGANIZATION_SCRIPT = `
local data = redis.call("GET", KEYS[1])
if not data then
  return false
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return false
end
local ok, record = pcall(cjson.decode, data)
if not ok then
  return false
end
record.activeOrganizationId = ARGV[1] == "__PAYLENS_NULL__" and cjson.null or ARGV[1]
record.activeMembershipId = ARGV[2] == "__PAYLENS_NULL__" and cjson.null or ARGV[2]
record.role = ARGV[3] == "__PAYLENS_NULL__" and cjson.null or ARGV[3]
redis.call("SET", KEYS[1], cjson.encode(record), "PX", ttl)
return cjson.encode(record)
`;
