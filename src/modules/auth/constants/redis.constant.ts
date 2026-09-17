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
