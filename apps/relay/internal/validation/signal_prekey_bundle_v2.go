package validation

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"echolet/apps/relay/internal/cryptoutil"
	"echolet/apps/relay/internal/model"
)

type jsonField struct {
	key   string
	value any
}
type orderedObject []jsonField

func (o orderedObject) get(key string) any {
	for _, p := range o {
		if p.key == key {
			return p.value
		}
	}
	return nil
}
func (o orderedObject) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, p := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(jsJSON(p.key))
		b.WriteByte(':')
		b.Write(jsJSON(p.value))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
func jsJSON(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	encoded := strings.TrimSuffix(b.String(), "\n")
	var result strings.Builder
	for i := 0; i < len(encoded); {
		if encoded[i] == '\\' && i+1 < len(encoded) {
			if strings.HasPrefix(encoded[i:], `\u2028`) {
				result.WriteRune('\u2028')
				i += 6
				continue
			}
			if strings.HasPrefix(encoded[i:], `\u2029`) {
				result.WriteRune('\u2029')
				i += 6
				continue
			}
			result.WriteString(encoded[i : i+2])
			i += 2
			continue
		}
		result.WriteByte(encoded[i])
		i++
	}
	return []byte(result.String())
}

// Token decoding preserves nested insertion order and rejects duplicate members.
func readOrdered(d *json.Decoder) (any, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := t.(json.Delim); ok {
		if delim != '{' {
			return nil, model.ErrV2Schema
		}
		result := orderedObject{}
		seen := map[string]bool{}
		for d.More() {
			token, e := d.Token()
			if e != nil {
				return nil, e
			}
			key, ok := token.(string)
			if !ok || seen[key] {
				return nil, model.ErrV2Schema
			}
			seen[key] = true
			value, e := readOrdered(d)
			if e != nil {
				return nil, e
			}
			result = append(result, jsonField{key, value})
		}
		_, err = d.Token()
		return result, err
	}
	return t, nil
}
func object(v any, required, optional string) (orderedObject, bool) {
	o, ok := v.(orderedObject)
	if !ok {
		return nil, false
	}
	allowed := map[string]bool{}
	for _, k := range strings.Fields(required + " " + optional) {
		allowed[k] = true
	}
	for _, p := range o {
		if !allowed[p.key] {
			return nil, false
		}
	}
	for _, k := range strings.Fields(required) {
		found := false
		for _, p := range o {
			if p.key == k {
				found = true
			}
		}
		if !found {
			return nil, false
		}
	}
	return o, true
}
func number(v any, max float64) bool {
	n, ok := v.(float64)
	return ok && n >= 0 && n <= max && math.Trunc(n) == n
}
func b64(v any, n int, prefix int) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(s)
	return e == nil && len(b) == n && base64.RawURLEncoding.EncodeToString(b) == s && (prefix < 0 || int(b[0]) == prefix)
}

var uuidV2 = regexp.MustCompile(`^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func validUUID(v any) bool { s, ok := v.(string); return ok && uuidV2.MatchString(s) }
func ValidateSignalSelector(claimID, identityID string, deviceID *string) error {
	if !validUUID(claimID) || !b64(identityID, 32, -1) || (deviceID != nil && !validUUID(*deviceID)) {
		return model.ErrV2Schema
	}
	return nil
}
func ValidateSignalPreKeyBundleV2(raw []byte, now int64) (*model.SignalPreKeyBundleV2, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	value, err := readOrdered(d)
	if err != nil {
		return nil, model.ErrV2Schema
	}
	if _, e := d.Token(); e != io.EOF {
		return nil, model.ErrV2Schema
	}
	root, ok := object(value, "type version suite bundle_id created_at_ms expires_at_ms device_record registration_id signal_identity_key signed_prekey kyber_prekey one_time_prekey signature", "")
	if !ok || root.get("type") != "signal_prekey_bundle" || root.get("version") != float64(2) || root.get("suite") != "libsignal-pq-v1" || !validUUID(root.get("bundle_id")) {
		return nil, model.ErrV2Schema
	}
	for _, k := range []string{"created_at_ms", "expires_at_ms"} {
		if !number(root.get(k), 9007199254740991) {
			return nil, model.ErrV2Schema
		}
	}
	created := int64(root.get("created_at_ms").(float64))
	expires := int64(root.get("expires_at_ms").(float64))
	if expires <= created || expires-created > 7*24*60*60*1000 {
		return nil, model.ErrV2Schema
	}
	dr, ok := object(root.get("device_record"), "type version identity_id device_id device_pubkey capabilities created_at_ms signature", "device_label")
	if !ok || dr.get("type") != "device_record" || dr.get("version") != float64(1) || !b64(dr.get("identity_id"), 32, -1) || !b64(dr.get("device_pubkey"), 32, -1) || !b64(dr.get("signature"), 64, -1) || !validUUID(dr.get("device_id")) || !number(dr.get("created_at_ms"), 9007199254740991) {
		return nil, model.ErrV2Schema
	}
	for _, p := range dr {
		if p.key == "device_label" {
			s, ok := p.value.(string)
			if !ok || len(utf16.Encode([]rune(s))) > 256 {
				return nil, model.ErrV2Schema
			}
		}
	}
	caps, ok := object(dr.get("capabilities"), "", "mailbox_poll receipts attachments")
	if !ok {
		return nil, model.ErrV2Schema
	}
	for _, p := range caps {
		if _, ok := p.value.(bool); !ok {
			return nil, model.ErrV2Schema
		}
	}
	if !number(root.get("registration_id"), 16380) || root.get("registration_id") == float64(0) || !b64(root.get("signal_identity_key"), 33, 5) || !b64(root.get("signature"), 64, -1) {
		return nil, model.ErrV2Schema
	}
	sp, ok := object(root.get("signed_prekey"), "key_id public_key signature", "")
	if !ok || !number(sp.get("key_id"), 4294967295) || !b64(sp.get("public_key"), 33, 5) || !b64(sp.get("signature"), 64, -1) {
		return nil, model.ErrV2Schema
	}
	kp, ok := object(root.get("kyber_prekey"), "key_id public_key signature", "")
	if !ok || !number(kp.get("key_id"), 4294967295) || !b64(kp.get("public_key"), 1569, 8) || !b64(kp.get("signature"), 64, -1) {
		return nil, model.ErrV2Schema
	}
	op, ok := object(root.get("one_time_prekey"), "key_id public_key", "")
	if !ok || !number(op.get("key_id"), 4294967295) || !b64(op.get("public_key"), 33, 5) {
		return nil, model.ErrV2Schema
	}
	if now < 0 || created > now || now >= expires || int64(dr.get("created_at_ms").(float64)) > created {
		return nil, model.ErrV2Expired
	}
	// Legacy root signature: sort top-level fields ONLY; nested capabilities order is signed.
	legacy := orderedObject{}
	for _, p := range dr {
		if p.key != "signature" {
			legacy = append(legacy, p)
		}
	}
	sort.Slice(legacy, func(i, j int) bool { return legacy[i].key < legacy[j].key })
	valid, e := cryptoutil.VerifyMessageSignature(string(jsJSON(legacy)), dr.get("signature").(string), dr.get("identity_id").(string))
	if e != nil || !valid {
		return nil, model.ErrV2Signature
	}
	tuple := []any{"echolet.signal.prekey_bundle.v2", root.get("bundle_id"), root.get("suite"), []any{dr.get("type"), dr.get("version"), dr.get("identity_id"), dr.get("device_id"), dr.get("device_pubkey"), dr.get("device_label"), []any{caps.get("mailbox_poll"), caps.get("receipts"), caps.get("attachments")}, dr.get("created_at_ms"), dr.get("signature")}, root.get("created_at_ms"), root.get("expires_at_ms"), root.get("registration_id"), root.get("signal_identity_key"), []any{sp.get("key_id"), sp.get("public_key"), sp.get("signature")}, []any{kp.get("key_id"), kp.get("public_key"), kp.get("signature")}, []any{op.get("key_id"), op.get("public_key")}}
	valid, e = cryptoutil.VerifyMessageSignature(string(jsJSON(tuple)), root.get("signature").(string), dr.get("device_pubkey").(string))
	if e != nil || !valid {
		return nil, model.ErrV2Signature
	}
	var deviceRecord model.DeviceRecord
	if err := json.Unmarshal(jsJSON(dr), &deviceRecord); err != nil {
		return nil, model.ErrV2Schema
	}
	return &model.SignalPreKeyBundleV2{BundleID: root.get("bundle_id").(string), IdentityID: dr.get("identity_id").(string), DeviceID: dr.get("device_id").(string), DeviceRecord: deviceRecord, SignalIdentity: root.get("signal_identity_key").(string), OneTimeKeyID: uint32(op.get("key_id").(float64)), OneTimePublicKey: op.get("public_key").(string), CreatedAtMS: created, ExpiresAtMS: expires, Raw: append([]byte(nil), raw...)}, nil
}
