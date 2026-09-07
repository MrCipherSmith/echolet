package handler

import (
	"encoding/json"
	"net/http"

	"echolet/apps/relay/internal/model"
	"echolet/apps/relay/internal/service"
	"echolet/apps/relay/internal/validation"
)

type DeviceRecordHandler struct {
	service *service.DeviceRecordService
}

func NewDeviceRecordHandler(svc *service.DeviceRecordService) *DeviceRecordHandler {
	return &DeviceRecordHandler{service: svc}
}

type PublishDeviceRecordRequest struct {
	DeviceRecord *model.DeviceRecord `json:"device_record"`
}

func writeJSONError(w http.ResponseWriter, code int, errorCode string, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": false,
		"error": map[string]string{
			"code":    errorCode,
			"message": message,
		},
	})
}

func (h *DeviceRecordHandler) PublishDeviceRecord(w http.ResponseWriter, r *http.Request) {
	var req PublishDeviceRecordRequest
	if !decodeJSONRequest(w, r, compactRequestBodyLimit, &req) {
		return
	}

	if req.DeviceRecord == nil {
		writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", "device_record is required")
		return
	}

	if err := validation.ValidateDeviceRecord(req.DeviceRecord); err != nil {
		if ve, ok := err.(*validation.ValidationError); ok {
			writeJSONError(w, http.StatusBadRequest, ve.Code, ve.Message)
		} else {
			writeJSONError(w, http.StatusBadRequest, "INVALID_SCHEMA", err.Error())
		}
		return
	}

	if err := h.service.PublishDeviceRecord(req.DeviceRecord); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to save device record")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
		"data": map[string]interface{}{
			"stored":    true,
			"device_id": req.DeviceRecord.DeviceID,
		},
	})
}
