package validation

import "testing"

func TestSignalV2JSONSeparatorsAndLiteralEscapeRemainDistinct(t *testing.T) {
	if string(jsJSON("\u2028")) != "\"\u2028\"" {
		t.Fatal("JSON.stringify literal separator mismatch")
	}
	if string(jsJSON(`\u2028`)) != `"\\u2028"` {
		t.Fatal("literal escape text changed")
	}
}
func TestSignalV2UUIDMatchesSharedSchema(t *testing.T) {
	for _, bad := range []string{"aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa"} {
		if validUUID(bad) {
			t.Errorf("accepted non-RFC UUID %s", bad)
		}
	}
	for _, good := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"} {
		if !validUUID(good) {
			t.Errorf("rejected UUID %s", good)
		}
	}
}
