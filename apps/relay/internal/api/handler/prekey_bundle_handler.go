package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/validation"
)

type PreKeyBundleHandler struct {
	service *service.PreKeyBundleService
	nowMS   func() int64
}

func NewPreKeyBundleHandler(svc *service.PreKeyBundleService) *PreKeyBundleHandler {
	return &PreKeyBundleHandler{service: svc, nowMS: func() int64 { return time.Now().UnixMilli() }}
}

type PublishPreKeyBundleRequest struct {
	Bundle *model.PreKeyBundle `json:"bundle"`
}

func (h *PreKeyBundleHandler) PublishPreKeyBundle(w http.ResponseWriter, r *http.Request) {
	var req PublishPreKeyBundleRequest
	if !decodeJSONRequest(w, r, envelopeRequestBodyLimit, &req) {
		return
	}

	if req.Bundle == nil {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "bundle is required")
		return
	}

	if len(req.Bundle.OneTimePreKeys) > maxOneTimePreKeysPerBundle {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "one_time_prekeys exceeds the maximum bundle size")
		return
	}

	if err := validation.ValidatePreKeyBundle(req.Bundle); err != nil {
		if ve, ok := err.(*validation.ValidationError); ok {
			writeJSONError(w, http.StatusBadRequest, ve.Code, ve.Message)
		} else {
			writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", err.Error())
		}
		return
	}

	if err := h.service.PublishPreKeyBundle(req.Bundle); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save prekey bundle")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": map[string]interface{}{
			"stored":                 true,
			"bundle_id":              req.Bundle.BundleID,
			"one_time_prekeys_count": len(req.Bundle.OneTimePreKeys),
		},
	})
}

func (h *PreKeyBundleHandler) GetPreKeyBundles(w http.ResponseWriter, r *http.Request, identityID string) {
	bundles, err := h.service.GetPreKeyBundles(identityID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to get prekey bundles")
		return
	}

	if bundles == nil || len(bundles) == 0 {
		writeJSONError(w, http.StatusNotFound, "PREKEY_BUNDLE_NOT_FOUND", "no prekey bundles found")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": map[string]interface{}{
			"bundles": bundles,
		},
	})
}
