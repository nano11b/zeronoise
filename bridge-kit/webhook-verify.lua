-- zeronoise outgoing webhook signature check for FiveM (Lua 5.4, no libraries).
-- x-zn-signature = "sha256=" .. hex(HMAC_SHA256(secret, timestamp .. "." .. rawBody))
local K = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 }
local M = 0xffffffff
local function rotr(x, n) return ((x >> n) | (x << (32 - n))) & M end
local function sha256(msg)
  local h = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 }
  local len = #msg
  msg = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I8", len * 8)
  for c = 1, #msg, 64 do
    local w = {}
    for i = 0, 15 do w[i] = string.unpack(">I4", msg, c + i * 4) end
    for i = 16, 63 do
      local s0 = rotr(w[i-15], 7) ~ rotr(w[i-15], 18) ~ (w[i-15] >> 3)
      local s1 = rotr(w[i-2], 17) ~ rotr(w[i-2], 19) ~ (w[i-2] >> 10)
      w[i] = (w[i-16] + s0 + w[i-7] + s1) & M
    end
    local a, b, cc, d, e, f, g, hh = table.unpack(h)
    for i = 0, 63 do
      local S1 = rotr(e, 6) ~ rotr(e, 11) ~ rotr(e, 25)
      local ch = (e & f) ~ (~e & g)
      local t1 = (hh + S1 + ch + K[i + 1] + w[i]) & M
      local S0 = rotr(a, 2) ~ rotr(a, 13) ~ rotr(a, 22)
      local mj = (a & b) ~ (a & cc) ~ (b & cc)
      local t2 = (S0 + mj) & M
      hh, g, f, e, d, cc, b, a = g, f, e, (d + t1) & M, cc, b, a, (t1 + t2) & M
    end
    local v = { a, b, cc, d, e, f, g, hh }
    for i = 1, 8 do h[i] = (h[i] + v[i]) & M end
  end
  return string.pack(">I4I4I4I4I4I4I4I4", table.unpack(h))
end
local function hmac_sha256(key, msg)
  if #key > 64 then key = sha256(key) end
  key = key .. string.rep("\0", 64 - #key)
  local ipad = key:gsub(".", function(ch) return string.char(ch:byte() ~ 0x36) end)
  local opad = key:gsub(".", function(ch) return string.char(ch:byte() ~ 0x5c) end)
  return sha256(opad .. sha256(ipad .. msg))
end
local function tohex(s) return (s:gsub(".", function(ch) return string.format("%02x", ch:byte()) end)) end

--- true when the delivery is genuine and fresh (timestamp in Unix seconds, within 5 minutes)
function VerifyZeronoise(secret, timestamp, rawBody, signature)
  if type(signature) ~= "string" or type(timestamp) ~= "string" then return false end
  local ts = tonumber(timestamp)
  if not ts or math.abs(os.time() - ts) > 300 then return false end
  local want = "sha256=" .. tohex(hmac_sha256(secret, timestamp .. "." .. rawBody))
  if #want ~= #signature then return false end
  local diff = 0
  for i = 1, #want do diff = diff | (want:byte(i) ~ signature:byte(i)) end
  return diff == 0
end

return { sha256 = sha256, hmac_sha256 = hmac_sha256, tohex = tohex, verify = VerifyZeronoise }
