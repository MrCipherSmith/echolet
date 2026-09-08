package handler

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/storage"
	"echolet/apps/relay/internal/storage/repository"
)

// Flow 003 / T26 group D — the relay contract a client-side prekey POOL depends on.
//
// THESE TWO TESTS ARE NOT RED, AND THAT IS DELIBERATE. T26 §6 group D says so in advance:
// both properties are already true of this tree (measured at T26 P1 and P5), the pool design
// changes no relay file, and nothing in the tree asserts them. They are written as REGRESSION
// PINS, not as a specification of work to be done, because the whole client-side pool rests on
// them:
//
//   - N independently signed bundles from one identity are simultaneously claimable, one claim
//     consumes exactly one of them, and the (N+1)st claimant is answered with today's exact
//     404 PREKEY_BUNDLE_UNAVAILABLE — the vocabulary T26 §4 keeps unchanged, and the reason
//     Signal's shared last-resort key is NOT adopted here;
//   - a consumed member is never re-offered. This is the load-bearing negative of the whole
//     task: handing one one-time prekey to two senders makes the second sender's message
//     UNDECRYPTABLE rather than merely refused, which is strictly worse than the denial the
//     pool exists to make rarer.
//
// The permanent-reservation guards in
// storage/repository/prekey_bundle_v2_test.go (TestSignalPreKeyBundleV2OneTimePreKeyReservationsArePermanent
// and siblings) are NOT edited and must keep passing unmodified. These tests approach the same
// property from the HTTP boundary and across a pool rather than a single publication, so the two
// sets are complementary; neither replaces the other.
//
// Bundles here are minted in-process from freshly generated ed25519 keys. /v2/prekeys/publish is
// unauthenticated, so every field below is caller-chosen — exactly as it is for a real client.
// No key material, no store key and no request body is ever printed: failures carry field names,
// counts, status codes, error codes and bundle ids only.

// poolSize is LIMITS.PREKEY_MIN_COUNT from packages/protocol/src/constants/limits.ts — the number
// the protocol already declares for this quantity. It is transcribed rather than invented; T26 §2.2
// explains why no second number for one quantity is minted.
const poolSize = 20

// poolNowMS and the seven-day window the validator enforces
// (validation/signal_prekey_bundle_v2.go: expires-created <= 7d, created <= now < expires).
const (
	poolCreatedBaseMS = int64(1770000000000)
	poolWindowMS      = int64(6 * 24 * 60 * 60 * 1000)
)

func TestSignalV2PoolServesOneClaimPerMemberAndRefusesTheNextSender(t *testing.T) {
	handler := newPoolHandler(t)
	identity := newPoolIdentity(t)

	// Ascending created_at_ms, one per member. The availability key is
	// v2:available:<identity>:<created_at_ms as 16 digits>:<bundle_id> and ClaimSignalV2 iterates
	// it in ascending byte order, so the OLDEST member — the one closest to expiry — must be
	// consumed first. That ordering is what stops a pool from leaving its most perishable member
	// behind, so it is asserted rather than assumed.
	members := make([]poolMember, poolSize)
	for index := range members {
		members[index] = identity.member(t, index)
	}

	// Published NEWEST FIRST, so a claim order that merely echoed publication order would fail.
	for index := len(members) - 1; index >= 0; index-- {
		claimable := publishPoolMember(t, handler, members[index], http.StatusOK)
		if !claimable {
			t.Fatalf("publish(member %d) claimable = false, want true: %d independently signed bundles from one identity must be simultaneously claimable, which is the entire premise of a pool", index, poolSize)
		}
	}

	claimedBundleIDs := make([]string, 0, poolSize)
	claimedOneTimeKeyIDs := map[uint32]int{}
	for index := 0; index < poolSize; index++ {
		bundle := claimPool(t, handler, identity, poolClaimID(index), http.StatusOK, "")
		claimedBundleIDs = append(claimedBundleIDs, bundle.BundleID)
		claimedOneTimeKeyIDs[bundle.OneTimePreKey.KeyID]++
		if want := members[index].bundleID; bundle.BundleID != want {
			t.Fatalf("claim %d returned bundle_id %s, want %s: claims must be served oldest-created first so the member closest to expiry is never the one left behind", index, bundle.BundleID, want)
		}
	}
	if len(claimedOneTimeKeyIDs) != poolSize {
		t.Fatalf("distinct one-time prekeys across %d claims = %d, want %d: one claim must consume exactly one member and no one-time prekey may be served twice", poolSize, len(claimedOneTimeKeyIDs), poolSize)
	}
	if distinct := distinctStrings(claimedBundleIDs); distinct != poolSize {
		t.Fatalf("distinct bundle ids across %d claims = %d, want %d", poolSize, distinct, poolSize)
	}

	// The (N+1)st sender. T26 §4: what she sees at exhaustion is exactly what she sees today —
	// 404 PREKEY_BUNDLE_UNAVAILABLE, no new code and no new shape. A last-resort key that could be
	// handed to her instead is deliberately NOT introduced.
	claimPool(t, handler, identity, poolClaimID(poolSize), http.StatusNotFound, "PREKEY_BUNDLE_UNAVAILABLE")
}

func TestSignalV2PoolNeverReOffersAConsumedMember(t *testing.T) {
	handler := newPoolHandler(t)
	identity := newPoolIdentity(t)

	members := make([]poolMember, poolSize)
	for index := range members {
		members[index] = identity.member(t, index)
		publishPoolMember(t, handler, members[index], http.StatusOK)
	}

	// One claim consumes the oldest member.
	consumed := claimPool(t, handler, identity, poolClaimID(0), http.StatusOK, "")
	consumedIndex := indexOfBundle(t, members, consumed.BundleID)

	// A byte-identical re-publish of the consumed member is idempotent and answers claimable=false.
	// SaveSignalV2's idempotent branch re-stores the same bytes and deliberately never re-adds the
	// availability index (storage/repository/signal_prekey_bundle_v2.go:29-36). A client that tops
	// its pool up by re-submitting every stored member runs this path N times per invocation, so it
	// is the single most-exercised guarantee in the design.
	if claimable := publishPoolMember(t, handler, members[consumedIndex], http.StatusOK); claimable {
		t.Fatalf("re-publish(consumed member %d) claimable = true, want false: a consumed one-time prekey must never be re-offered — serving it to a second sender makes that sender's message undecryptable rather than merely refused", consumedIndex)
	}

	// Every other member is untouched by the claim and by that re-publish.
	for index, member := range members {
		if index == consumedIndex {
			continue
		}
		if claimable := publishPoolMember(t, handler, member, http.StatusOK); !claimable {
			t.Fatalf("re-publish(unconsumed member %d) claimable = false, want true: topping a pool up must not disturb the members that are still live", index)
		}
	}

	// A fresh bundle_id around the SAME one-time prekey — the shape a client that pruned or
	// recycled key material would produce, and the shape a shared last-resort key would need — is
	// refused permanently, across the whole pool.
	recycled := identity.memberReusingOneTimePreKey(t, len(members), members[consumedIndex])
	publishPoolRaw(t, handler, recycled.raw, http.StatusConflict, "ONE_TIME_PREKEY_REUSED")

	// And no later claim id ever reaches the consumed member again.
	for index := 1; index < poolSize; index++ {
		bundle := claimPool(t, handler, identity, poolClaimID(index), http.StatusOK, "")
		if bundle.BundleID == consumed.BundleID {
			t.Fatalf("claim %d re-served the already-consumed member %s", index, consumed.BundleID)
		}
		if bundle.OneTimePreKey.PublicKey == consumed.OneTimePreKey.PublicKey {
			t.Fatalf("claim %d re-served the already-consumed one-time prekey (key_id %d)", index, consumed.OneTimePreKey.KeyID)
		}
	}
	claimPool(t, handler, identity, poolClaimID(poolSize), http.StatusNotFound, "PREKEY_BUNDLE_UNAVAILABLE")
}

// --- harness -----------------------------------------------------------------------------------

func newPoolHandler(t *testing.T) *PreKeyBundleHandler {
	t.Helper()
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewStorage() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	handler := NewPreKeyBundleHandler(service.NewPreKeyBundleService(repository.NewPreKeyBundleRepository(store)))
	handler.nowMS = func() int64 { return poolCreatedBaseMS + int64(poolSize) }
	return handler
}

type poolMember struct {
	bundleID              string
	oneTimeKeyID          uint32
	oneTimePublicKey      string
	raw                   json.RawMessage
	createdAtMilliseconds int64
}

type poolClaimedBundle struct {
	BundleID      string `json:"bundle_id"`
	OneTimePreKey struct {
		KeyID     uint32 `json:"key_id"`
		PublicKey string `json:"public_key"`
	} `json:"one_time_prekey"`
}

type poolIdentity struct {
	identityID   string
	identityKey  ed25519.PrivateKey
	deviceID     string
	devicePubKey string
	deviceKey    ed25519.PrivateKey
	deviceRecord json.RawMessage
	recordFields []any
}

func newPoolIdentity(t *testing.T) *poolIdentity {
	t.Helper()
	identityPublic, identityPrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey(identity) error = %v", err)
	}
	devicePublic, devicePrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey(device) error = %v", err)
	}
	value := &poolIdentity{
		identityID:   base64.RawURLEncoding.EncodeToString(identityPublic),
		identityKey:  identityPrivate,
		deviceID:     "8cc8010b-d4a1-4ce7-8203-a8f6b055c1b9",
		devicePubKey: base64.RawURLEncoding.EncodeToString(devicePublic),
		deviceKey:    devicePrivate,
	}

	capabilities := poolObject(t,
		poolField{"mailbox_poll", true},
		poolField{"receipts", false},
		poolField{"attachments", false},
	)
	fields := []poolField{
		{"type", "device_record"},
		{"version", 1},
		{"identity_id", value.identityID},
		{"device_id", value.deviceID},
		{"device_pubkey", value.devicePubKey},
		{"device_label", "cli-device"},
		{"capabilities", capabilities},
		{"created_at_ms", poolCreatedBaseMS},
	}
	// The relay verifies the device record's own signature over its TOP-LEVEL fields sorted by
	// name, with nested `capabilities` insertion order preserved
	// (validation/signal_prekey_bundle_v2.go:219-229).
	sorted := append([]poolField(nil), fields...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].key < sorted[j].key })
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(identityPrivate, poolObject(t, sorted...)))
	value.deviceRecord = poolObject(t, append(append([]poolField(nil), fields...), poolField{"signature", signature})...)
	value.recordFields = []any{
		"device_record", 1, value.identityID, value.deviceID, value.devicePubKey, "cli-device",
		[]any{true, false, false}, poolCreatedBaseMS, signature,
	}
	return value
}

// member mints one independently signed pool member: its own bundle_id, its own one-time prekey
// key_id and its own one-time prekey public key, exactly as `rotateOneTimePreKey()` produces on
// the client. T26 P1 measured that N of these are simultaneously claimable.
func (p *poolIdentity) member(t *testing.T, index int) poolMember {
	t.Helper()
	created := poolCreatedBaseMS + int64(index)
	return p.sign(t, poolBundleID(index), created, uint32(index+1), poolCurveKey(byte(index+1)))
}

// memberReusingOneTimePreKey re-signs a NEW bundle around an ALREADY PUBLISHED one-time prekey.
// A correct relay refuses it permanently; a client that pruned or recycled key material would
// produce exactly this.
func (p *poolIdentity) memberReusingOneTimePreKey(t *testing.T, index int, reused poolMember) poolMember {
	t.Helper()
	created := poolCreatedBaseMS + int64(index)
	return p.sign(t, poolBundleID(index), created, reused.oneTimeKeyID, reused.oneTimePublicKey)
}

func (p *poolIdentity) sign(t *testing.T, bundleID string, created int64, oneTimeKeyID uint32, oneTimePublicKey string) poolMember {
	t.Helper()
	const suite = "libsignal-pq-v1"
	expires := created + poolWindowMS
	registrationID := 4242
	signalIdentityKey := poolCurveKey(0x21)
	signedPreKey := []any{uint32(1), poolCurveKey(0x22), poolSignatureBytes(0x23)}
	kyberPreKey := []any{uint32(1), poolKyberKey(0x24), poolSignatureBytes(0x25)}

	// The signed tuple (validation/signal_prekey_bundle_v2.go:231). `bundle_id` is INSIDE it, which
	// is why a one-time prekey re-offered under a fresh bundle_id cannot simply replay an old
	// signature.
	tuple := []any{
		"echolet.signal.prekey_bundle.v2", bundleID, suite, p.recordFields,
		created, expires, registrationID, signalIdentityKey,
		signedPreKey, kyberPreKey, []any{oneTimeKeyID, oneTimePublicKey},
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.deviceKey, poolJSON(t, tuple)))

	raw := poolObject(t,
		poolField{"type", "signal_prekey_bundle"},
		poolField{"version", 2},
		poolField{"suite", suite},
		poolField{"bundle_id", bundleID},
		poolField{"created_at_ms", created},
		poolField{"expires_at_ms", expires},
		poolField{"device_record", p.deviceRecord},
		poolField{"registration_id", registrationID},
		poolField{"signal_identity_key", signalIdentityKey},
		poolField{"signed_prekey", poolObject(t,
			poolField{"key_id", signedPreKey[0]}, poolField{"public_key", signedPreKey[1]}, poolField{"signature", signedPreKey[2]})},
		poolField{"kyber_prekey", poolObject(t,
			poolField{"key_id", kyberPreKey[0]}, poolField{"public_key", kyberPreKey[1]}, poolField{"signature", kyberPreKey[2]})},
		poolField{"one_time_prekey", poolObject(t,
			poolField{"key_id", oneTimeKeyID}, poolField{"public_key", oneTimePublicKey})},
		poolField{"signature", signature},
	)
	return poolMember{
		bundleID: bundleID, oneTimeKeyID: oneTimeKeyID, oneTimePublicKey: oneTimePublicKey,
		raw: raw, createdAtMilliseconds: created,
	}
}

func publishPoolMember(t *testing.T, handler *PreKeyBundleHandler, member poolMember, wantStatus int) bool {
	t.Helper()
	body := publishPoolRaw(t, handler, member.raw, wantStatus, "")
	var response struct {
		Data struct {
			Stored    bool   `json:"stored"`
			BundleID  string `json:"bundle_id"`
			Claimable bool   `json:"claimable"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode publish response: %v", err)
	}
	if !response.Data.Stored || response.Data.BundleID != member.bundleID {
		t.Fatalf("publish response stored=%v bundle_id=%s, want stored=true bundle_id=%s", response.Data.Stored, response.Data.BundleID, member.bundleID)
	}
	return response.Data.Claimable
}

func publishPoolRaw(t *testing.T, handler *PreKeyBundleHandler, bundle json.RawMessage, wantStatus int, wantCode string) []byte {
	t.Helper()
	request := append(append([]byte(`{"bundle":`), bundle...), '}')
	recorder := httptest.NewRecorder()
	handler.PublishSignalPreKeyBundleV2(recorder, httptest.NewRequest(http.MethodPost, "/v2/prekeys/publish", bytes.NewReader(request)))
	assertPoolResponse(t, recorder, wantStatus, wantCode, "publish")
	return recorder.Body.Bytes()
}

func claimPool(t *testing.T, handler *PreKeyBundleHandler, identity *poolIdentity, claimID string, wantStatus int, wantCode string) poolClaimedBundle {
	t.Helper()
	request := []byte(`{"claim_id":"` + claimID + `","identity_id":"` + identity.identityID + `","device_id":null}`)
	recorder := httptest.NewRecorder()
	handler.ClaimSignalPreKeyBundleV2(recorder, httptest.NewRequest(http.MethodPost, "/v2/prekeys/claim", bytes.NewReader(request)))
	assertPoolResponse(t, recorder, wantStatus, wantCode, "claim")
	if wantStatus != http.StatusOK {
		return poolClaimedBundle{}
	}
	var response struct {
		Data struct {
			Bundle poolClaimedBundle `json:"bundle"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode claim response: %v", err)
	}
	return response.Data.Bundle
}

func assertPoolResponse(t *testing.T, recorder *httptest.ResponseRecorder, wantStatus int, wantCode, what string) {
	t.Helper()
	if recorder.Code != wantStatus {
		t.Fatalf("%s status = %d, want %d (error code %q)", what, recorder.Code, wantStatus, poolErrorCode(recorder))
	}
	if wantCode != "" && poolErrorCode(recorder) != wantCode {
		t.Fatalf("%s error code = %q, want %q", what, poolErrorCode(recorder), wantCode)
	}
}

func poolErrorCode(recorder *httptest.ResponseRecorder) string {
	var response struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(recorder.Body.Bytes(), &response) != nil {
		return ""
	}
	return response.Error.Code
}

func indexOfBundle(t *testing.T, members []poolMember, bundleID string) int {
	t.Helper()
	for index, member := range members {
		if member.bundleID == bundleID {
			return index
		}
	}
	t.Fatalf("claim returned bundle id %s, which is not a published pool member", bundleID)
	return -1
}

func distinctStrings(values []string) int {
	seen := map[string]bool{}
	for _, value := range values {
		seen[value] = true
	}
	return len(seen)
}

// --- deterministic JSON ---------------------------------------------------------------------

type poolField struct {
	key   string
	value any
}

// poolObject and poolJSON reproduce the relay's own transcript serialization
// (validation/signal_prekey_bundle_v2.go jsJSON): insertion order preserved, no HTML escaping.
// Every value used here is ASCII base64url, an alphabet with no HTML-escapable character, so
// encoding/json's default output is byte-identical to the validator's.
func poolObject(t *testing.T, fields ...poolField) json.RawMessage {
	t.Helper()
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, field := range fields {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := json.Marshal(field.key)
		if err != nil {
			t.Fatalf("marshal field name: %v", err)
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(poolJSON(t, field.value))
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

func poolJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal value: %v", err)
	}
	return encoded
}

func poolBundleID(index int) string {
	return fmt.Sprintf("%08x-0000-4000-8000-%012x", index+1, index+1)
}

func poolClaimID(index int) string {
	return fmt.Sprintf("%08x-1111-4111-8111-%012x", index+1, index+1)
}

// poolCurveKey is a 33-byte DJB-type public key (leading 0x05), the shape the validator requires
// for signal_identity_key, signed_prekey.public_key and one_time_prekey.public_key. Synthetic
// padding: the relay verifies neither the curve point nor the prekey signatures.
func poolCurveKey(seed byte) string {
	key := make([]byte, 33)
	key[0] = 5
	for index := 1; index < len(key); index++ {
		key[index] = seed + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(key)
}

// poolKyberKey is a 1569-byte Kyber public key (leading 0x08).
func poolKyberKey(seed byte) string {
	key := make([]byte, 1569)
	key[0] = 8
	for index := 1; index < len(key); index++ {
		key[index] = seed + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(key)
}

func poolSignatureBytes(seed byte) string {
	signature := make([]byte, 64)
	for index := range signature {
		signature[index] = seed + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(signature)
}
