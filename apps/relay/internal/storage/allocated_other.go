//go:build !unix

package storage

import "io/fs"

// allocatedBytes falls back to the apparent size where the platform exposes no
// block count. It over-reports Badger's sparse files, so a cap there errs on
// the side of refusing writes early rather than letting the disk fill.
func allocatedBytes(info fs.FileInfo) int64 {
	return info.Size()
}
