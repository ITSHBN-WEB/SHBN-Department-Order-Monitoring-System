// Initial sign-in data. These are salted scrypt HASHES, not passwords (see lib/auth.js).
// They are only inserted if missing, so changing a password later (scripts/hash-password.js) is never overwritten.
export const ACCOUNT_SEED = [
  { code: '1008-SHBN', hash: 'scrypt$ia2gX+KUSB3nW1jC8aef+w==$PKGBjpoL3ejiiArnmeyw9QEWyRPpZpHe6dOlV2ORhFU=' },
  { code: '1015-SHPL', hash: 'scrypt$vXeP8idFovCslQTG6+nFig==$XSjpgYxxyfSYxkKSmLBKYqfugwmFRuNbBvGNvk/a5vY=' },
  { code: '1007-SHPP', hash: 'scrypt$m7zUpXYQbgzUqS7/tVwqUQ==$VsCbLcRb3fpqqzQXRNRv8kJtZOEIlpgQlqrx8xdStH8=' }
];
export const ADMIN_HASH = 'scrypt$qP7RAkDQl1NnTCqtf8vfSg==$nZNWs6aZhMi8nvE1TpfMrP+iOgr3fngnDTaK+kDUZYo=';   // per-account Admin tab password
export const HQ_HASH = 'scrypt$00Ft+txDUte+/JMCX8EF7g==$pnMXq/AF6ZmfvMwS1DN1Rb4xRdmfGKYZDCjRYTj1xmA=';      // head-office Admin tab password (all accounts)
