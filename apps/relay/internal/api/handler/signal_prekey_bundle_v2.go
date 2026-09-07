package handler

import (
	"echolet/apps/relay/internal/model"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func v2Error(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "INTERNAL_ERROR"
	for _, candidate := range []error{model.ErrV2Schema, model.ErrV2Signature, model.ErrV2Expired, model.ErrV2BundleConflict, model.ErrV2ClaimConflict, model.ErrV2PreKeyReused, model.ErrV2Unavailable} {
		if errors.Is(err, candidate) {
			code = candidate.Error()
			switch candidate {
			case model.ErrV2BundleConflict, model.ErrV2ClaimConflict, model.ErrV2PreKeyReused:
				status = http.StatusConflict
			case model.ErrV2Unavailable:
				status = http.StatusNotFound
			default:
				status = http.StatusBadRequest
			}
			break
		}
	}
	writeJSONError(w, status, code, code)
}
func decodeV2Request(w http.ResponseWriter, r *http.Request, required []string) (map[string]json.RawMessage, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	d := json.NewDecoder(r.Body)
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		v2Error(w, model.ErrV2Schema)
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	allowed := map[string]bool{}
	for _, key := range required {
		allowed[key] = true
	}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			v2Error(w, model.ErrV2Schema)
			return nil, false
		}
		key, ok := token.(string)
		if !ok || !allowed[key] || fields[key] != nil {
			v2Error(w, model.ErrV2Schema)
			return nil, false
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			v2Error(w, model.ErrV2Schema)
			return nil, false
		}
		fields[key] = value
	}
	if _, err := d.Token(); err != nil {
		v2Error(w, model.ErrV2Schema)
		return nil, false
	}
	if _, err := d.Token(); err != io.EOF {
		v2Error(w, model.ErrV2Schema)
		return nil, false
	}
	if len(fields) != len(required) {
		v2Error(w, model.ErrV2Schema)
		return nil, false
	}
	return fields, true
}
func (h *PreKeyBundleHandler) PublishSignalPreKeyBundleV2(w http.ResponseWriter, r *http.Request) {
	fields, ok := decodeV2Request(w, r, []string{"bundle"})
	if !ok {
		return
	}
	// `claimable` is additive and always present: a publish response is otherwise byte-identical
	// on the first-store and the idempotent re-store paths, so without it a client cannot tell a
	// publication that can serve a first-contact sender from one whose bundle is already consumed.
	claimable, err := h.service.PublishSignalPreKeyBundleV2Claimable(fields["bundle"], h.nowMS())
	if err != nil {
		v2Error(w, err)
		return
	}
	var published struct {
		BundleID string `json:"bundle_id"`
	}
	if err := json.Unmarshal(fields["bundle"], &published); err != nil {
		v2Error(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true,
		"data": map[string]any{"stored": true, "bundle_id": published.BundleID, "claimable": claimable},
	})
}
func (h *PreKeyBundleHandler) ClaimSignalPreKeyBundleV2(w http.ResponseWriter, r *http.Request) {
	fields, ok := decodeV2Request(w, r, []string{"claim_id", "identity_id", "device_id"})
	if !ok {
		return
	}
	var claimID, identityID string
	var deviceID *string
	if json.Unmarshal(fields["claim_id"], &claimID) != nil || json.Unmarshal(fields["identity_id"], &identityID) != nil || json.Unmarshal(fields["device_id"], &deviceID) != nil {
		v2Error(w, model.ErrV2Schema)
		return
	}
	raw, err := h.service.ClaimSignalPreKeyBundleV2(claimID, identityID, deviceID, h.nowMS())
	if err != nil {
		v2Error(w, err)
		return
	}
	// Do not encode RawMessage: encoding/json compacts it and breaks exact replay.
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"data":{"bundle":`))
	_, _ = w.Write(raw)
	_, _ = w.Write([]byte(`}}`))
}
