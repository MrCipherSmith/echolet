//go:build unix

package storage

import (
	"io/fs"
	"syscall"
)

// allocatedBytes is the space a file really occupies on disk. st_blocks is
// always counted in 512-byte units, whatever the filesystem's block size.
func allocatedBytes(info fs.FileInfo) int64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return int64(stat.Blocks) * 512
	}
	return info.Size()
}
