// The one place that names the vendored files. Bumping a dependency means
// changing the pin in package.json and the path here, then rebuilding.
//
// These imports stay external: the vendor bundles are separate files with their
// own subresource-integrity hashes, so they can be reviewed and cached alone.

export {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  SimplePool,
  decodeNip19,
  npubEncode,
  getConversationKey,
  nip44Encrypt,
  BunkerSigner,
  createNostrConnectURI,
} from '/assets/js/vendor/nostr-tools/nostr-tools-2.25.2.esm.min.js'

export { encode as qrEncode } from '/assets/js/vendor/uqr/uqr-0.1.3.esm.min.js'
