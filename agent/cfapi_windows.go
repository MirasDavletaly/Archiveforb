//go:build windows

package main

// The Windows Cloud Files API (cldapi.dll), the same one OneDrive uses for "files on demand": files show up in the
// folder as placeholders and Windows asks this program for the data when one is opened. Struct layouts follow
// cfapi.h for 64-bit Windows; the callbacks read their parameters at the documented offsets.

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	cldapi                     = windows.NewLazySystemDLL("cldapi.dll")
	procCfConnectSyncRoot      = cldapi.NewProc("CfConnectSyncRoot")
	procCfDisconnectSyncRoot   = cldapi.NewProc("CfDisconnectSyncRoot")
	procCfExecute              = cldapi.NewProc("CfExecute")
	procCfCreatePlaceholders   = cldapi.NewProc("CfCreatePlaceholders")
	procCfConvertToPlaceholder = cldapi.NewProc("CfConvertToPlaceholder")
	procCfUpdatePlaceholder    = cldapi.NewProc("CfUpdatePlaceholder")
	procCfGetPlaceholderInfo   = cldapi.NewProc("CfGetPlaceholderInfo")
	procCfRevertPlaceholder    = cldapi.NewProc("CfRevertPlaceholder")
	procCfHydratePlaceholder   = cldapi.NewProc("CfHydratePlaceholder")
	procCfUnregisterSyncRoot   = cldapi.NewProc("CfUnregisterSyncRoot")
)

const (
	cfCallbackFetchData           = 0
	cfCallbackCancelFetchData     = 2
	cfCallbackFetchPlaceholders   = 3
	cfCallbackNotifyCloseComplete = 6
	cfCallbackNotifyDelete        = 9
	cfCallbackNotifyRename        = 11
	cfCallbackNone                = 0xffffffff

	cfOpTransferData         = 0
	cfOpTransferPlaceholders = 4
	cfOpAckDelete            = 6
	cfOpAckRename            = 7

	cfConnectRequireFullPath = 0x4

	cfPlaceholderMarkInSync     = 0x2
	cfPlaceholderNoPopulation   = 0x1 // a folder whose contents are already all there
	cfTransferNoMorePopulation  = 0x2 // CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION
	cfConvertMarkInSync         = 0x1
	cfConvertEnablePopulation   = 0x4
	cfUpdateMarkInSync          = 0x2
	cfUpdateDehydrate           = 0x4
	cfPlaceholderInfoStandard   = 1
	cfDeleteFlagIsDirectory     = 0x1
	cfRenameFlagTargetInScope   = 0x4
	cfRenameFlagSourceInScope   = 0x2
	cfCloseFlagDeleted          = 0x1
	statusSuccess               = 0
	statusUnsuccessful          = 0xC0000001
	statusAccessDenied          = 0xC0000022
	fileAttributeReadonly       = 0x1
	fileAttributeDirectory      = 0x10
	fileAttributeNormal         = 0x80
	fileAttributeRecallOnOpen   = 0x40000
	fileAttributeRecallOnAccess = 0x400000
	fileAttributePinned         = 0x80000
	fileAttributeUnpinned       = 0x100000
	findExOnDiskEntriesOnly     = 0x4
	cfPinStatePinned            = 1
	cfInSyncStateInSync         = 1
	transferChunk               = 4 << 20 // bytes per CfExecute; a multiple of 4 KB, as the API requires
)

type fileBasicInfo struct {
	CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
	FileAttributes                                          uint32
	_                                                       uint32
}

type cfFsMetadata struct {
	BasicInfo fileBasicInfo
	FileSize  int64
}

type cfPlaceholderCreateInfo struct {
	RelativeFileName   *uint16
	FsMetadata         cfFsMetadata
	FileIdentity       unsafe.Pointer
	FileIdentityLength uint32
	Flags              uint32
	Result             int32
	_                  uint32
	CreateUsn          int64
}

type cfCallbackInfo struct {
	StructSize             uint32
	_                      uint32
	ConnectionKey          int64
	CallbackContext        unsafe.Pointer
	VolumeGuidName         *uint16
	VolumeDosName          *uint16
	VolumeSerialNumber     uint32
	_                      uint32
	SyncRootFileID         int64
	SyncRootIdentity       unsafe.Pointer
	SyncRootIdentityLength uint32
	_                      uint32
	FileID                 int64
	FileSize               int64
	FileIdentity           unsafe.Pointer
	FileIdentityLength     uint32
	_                      uint32
	NormalizedPath         *uint16
	TransferKey            int64
	PriorityHint           uint8
	_                      [7]byte
	CorrelationVector      unsafe.Pointer
	ProcessInfo            unsafe.Pointer
	RequestKey             int64
}

// cfCallbackParams: CF_CALLBACK_PARAMETERS, read at the documented offsets of its union.
type cfCallbackParams struct {
	ParamSize uint32
	_         uint32
	raw       [96]byte
}

func (p *cfCallbackParams) u32(off uintptr) uint32 {
	return *(*uint32)(unsafe.Add(unsafe.Pointer(p), off))
}
func (p *cfCallbackParams) i64(off uintptr) int64 {
	return *(*int64)(unsafe.Add(unsafe.Pointer(p), off))
}
func (p *cfCallbackParams) str(off uintptr) string {
	return windows.UTF16PtrToString(*(**uint16)(unsafe.Add(unsafe.Pointer(p), off)))
}

type cfCallbackRegistration struct {
	Type     uint32
	_        uint32
	Callback uintptr
}

type cfOperationInfo struct {
	StructSize        uint32
	Type              uint32
	ConnectionKey     int64
	TransferKey       int64
	CorrelationVector unsafe.Pointer
	SyncStatus        unsafe.Pointer
	RequestKey        int64
}

type cfTransferDataParams struct {
	ParamSize        uint32
	_                uint32
	Flags            uint32
	CompletionStatus uint32
	Buffer           unsafe.Pointer
	Offset           int64
	Length           int64
}

type cfTransferPlaceholdersParams struct {
	ParamSize             uint32
	_                     uint32
	Flags                 uint32
	CompletionStatus      uint32
	PlaceholderTotalCount int64
	PlaceholderArray      *cfPlaceholderCreateInfo
	PlaceholderCount      uint32
	EntriesProcessed      uint32
}

type cfAckParams struct {
	ParamSize        uint32
	_                uint32
	Flags            uint32
	CompletionStatus uint32
}

func hresult(r uintptr) error {
	if int32(r) < 0 {
		return fmt.Errorf("HRESULT 0x%08x", uint32(r))
	}
	return nil
}

func (info *cfCallbackInfo) identity() []byte {
	if info.FileIdentity == nil || info.FileIdentityLength == 0 {
		return nil
	}
	return append([]byte(nil), unsafe.Slice((*byte)(info.FileIdentity), info.FileIdentityLength)...)
}

func (info *cfCallbackInfo) path() string { return windows.UTF16PtrToString(info.NormalizedPath) }

func (info *cfCallbackInfo) op(kind uint32) cfOperationInfo {
	return cfOperationInfo{StructSize: uint32(unsafe.Sizeof(cfOperationInfo{})), Type: kind, ConnectionKey: info.ConnectionKey, TransferKey: info.TransferKey, CorrelationVector: info.CorrelationVector, RequestKey: info.RequestKey}
}

func cfExecute(op *cfOperationInfo, params unsafe.Pointer) error {
	r, _, _ := procCfExecute.Call(uintptr(unsafe.Pointer(op)), uintptr(params))
	return hresult(r)
}

// cfFailData turns down a download: Windows wants the range it asked for named, or it keeps waiting (60 s).
func cfFailData(info *cfCallbackInfo, offset, length int64) error {
	op := info.op(cfOpTransferData)
	p := cfTransferDataParams{ParamSize: uint32(unsafe.Sizeof(cfTransferDataParams{})), CompletionStatus: statusUnsuccessful, Offset: offset, Length: length}
	return cfExecute(&op, unsafe.Pointer(&p))
}

// cfTransferData hands bytes of a file to Windows (or, with status != 0 and no data, fails the request).
func cfTransferData(info *cfCallbackInfo, offset int64, data []byte, status uint32) error {
	op := info.op(cfOpTransferData)
	p := cfTransferDataParams{ParamSize: uint32(unsafe.Sizeof(cfTransferDataParams{})), CompletionStatus: status, Offset: offset, Length: int64(len(data))}
	if len(data) > 0 {
		p.Buffer = unsafe.Pointer(&data[0])
	}
	return cfExecute(&op, unsafe.Pointer(&p))
}

func cfTransferPlaceholders(info *cfCallbackInfo, list []cfPlaceholderCreateInfo, status uint32) error {
	op := info.op(cfOpTransferPlaceholders)
	p := cfTransferPlaceholdersParams{ParamSize: uint32(unsafe.Sizeof(cfTransferPlaceholdersParams{})), Flags: cfTransferNoMorePopulation, CompletionStatus: status, PlaceholderTotalCount: int64(len(list)), PlaceholderCount: uint32(len(list))}
	if len(list) > 0 {
		p.PlaceholderArray = &list[0]
	}
	return cfExecute(&op, unsafe.Pointer(&p))
}

func cfAck(info *cfCallbackInfo, kind uint32, status uint32) error {
	op := info.op(kind)
	p := cfAckParams{ParamSize: uint32(unsafe.Sizeof(cfAckParams{})), CompletionStatus: status}
	return cfExecute(&op, unsafe.Pointer(&p))
}

// openForPlaceholder opens a file or folder in the sync root without making Windows fetch its data.
func openForPlaceholder(path string, write bool) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	access := uint32(windows.FILE_READ_ATTRIBUTES)
	if write {
		access |= windows.FILE_WRITE_ATTRIBUTES | windows.FILE_WRITE_DATA
	}
	return windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

type placeholderInfo struct {
	PinState, InSync int32
	Identity         []byte
	OnDisk           int64
}

func getPlaceholderInfo(path string) (*placeholderInfo, error) {
	h, err := openForPlaceholder(path, false)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, 60+1024)
	var n uint32
	r, _, _ := procCfGetPlaceholderInfo.Call(uintptr(h), cfPlaceholderInfoStandard, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)))
	if err := hresult(r); err != nil {
		return nil, err // not a placeholder (a file made here and not yet sent), or gone
	}
	idLen := *(*uint32)(unsafe.Pointer(&buf[56]))
	if 60+int(idLen) > len(buf) {
		idLen = uint32(len(buf) - 60)
	}
	return &placeholderInfo{
		OnDisk:   *(*int64)(unsafe.Pointer(&buf[0])),
		PinState: *(*int32)(unsafe.Pointer(&buf[32])),
		InSync:   *(*int32)(unsafe.Pointer(&buf[36])),
		Identity: append([]byte(nil), buf[60:60+idLen]...),
	}, nil
}

func convertToPlaceholder(path string, identity []byte, folder bool) error {
	h, err := openForPlaceholder(path, true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	flags := uintptr(cfConvertMarkInSync)
	if folder {
		flags = cfConvertMarkInSync // a folder made here: all of its contents are here already
	}
	r, _, _ := procCfConvertToPlaceholder.Call(uintptr(h), uintptr(unsafe.Pointer(&identity[0])), uintptr(len(identity)), flags, 0, 0)
	return hresult(r)
}

// updatePlaceholder gives a placeholder new metadata and identity; dehydrate drops its local data (it is fetched
// again, in the new version, when opened).
func updatePlaceholder(path string, meta *cfFsMetadata, identity []byte, dehydrate bool) error {
	h, err := openForPlaceholder(path, true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	flags := uintptr(cfUpdateMarkInSync)
	if dehydrate {
		flags |= cfUpdateDehydrate
	}
	var id uintptr
	if len(identity) > 0 {
		id = uintptr(unsafe.Pointer(&identity[0]))
	}
	r, _, _ := procCfUpdatePlaceholder.Call(uintptr(h), uintptr(unsafe.Pointer(meta)), id, uintptr(len(identity)), 0, 0, flags, 0, 0)
	return hresult(r)
}

func markInSync(path string, identity []byte) error {
	return updatePlaceholder(path, nil, identity, false)
}

func hydratePlaceholder(path string) error {
	h, err := openForPlaceholder(path, false)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	r, _, _ := procCfHydratePlaceholder.Call(uintptr(h), 0, ^uintptr(0)>>1, 0, 0) // offset 0, length "to the end"
	return hresult(r)
}

// revertPlaceholder turns a placeholder back into an ordinary file (used when this computer stops syncing).
func revertPlaceholder(path string) error {
	h, err := openForPlaceholder(path, true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	r, _, _ := procCfRevertPlaceholder.Call(uintptr(h), 0, 0)
	return hresult(r)
}

func createPlaceholders(dir string, list []cfPlaceholderCreateInfo) error {
	if len(list) == 0 {
		return nil
	}
	d, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	var done uint32
	r, _, _ := procCfCreatePlaceholders.Call(uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(&list[0])), uintptr(len(list)), 0, uintptr(unsafe.Pointer(&done)))
	return hresult(r)
}

func connectSyncRoot(root string, callbacks []cfCallbackRegistration) (int64, error) {
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return 0, err
	}
	callbacks = append(callbacks, cfCallbackRegistration{Type: cfCallbackNone})
	var key int64
	r, _, _ := procCfConnectSyncRoot.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&callbacks[0])), 0, cfConnectRequireFullPath, uintptr(unsafe.Pointer(&key)))
	return key, hresult(r)
}

func disconnectSyncRoot(key int64) { procCfDisconnectSyncRoot.Call(uintptr(key)) }

func unregisterSyncRootPath(root string) error {
	p, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return err
	}
	r, _, _ := procCfUnregisterSyncRoot.Call(uintptr(unsafe.Pointer(p)))
	return hresult(r)
}

// listOnDisk lists a folder in the sync root without making Windows ask for contents that are not there yet.
func listOnDisk(dir string) ([]windows.Win32finddata, error) {
	pattern, err := windows.UTF16PtrFromString(dir + `\*`)
	if err != nil {
		return nil, err
	}
	var data windows.Win32finddata
	h, err := findFirstFileEx(pattern, &data)
	if err != nil {
		if err == windows.ERROR_FILE_NOT_FOUND {
			return nil, nil
		}
		return nil, err
	}
	defer windows.FindClose(h)
	var out []windows.Win32finddata
	for {
		name := windows.UTF16ToString(data.FileName[:])
		if name != "." && name != ".." {
			out = append(out, data)
		}
		if err := windows.FindNextFile(h, &data); err != nil {
			break
		}
	}
	return out, nil
}

var procFindFirstFileExW = windows.NewLazySystemDLL("kernel32.dll").NewProc("FindFirstFileExW")

func findFirstFileEx(pattern *uint16, data *windows.Win32finddata) (windows.Handle, error) {
	const findExInfoBasic, findExSearchNameMatch = 1, 0
	r, _, e := procFindFirstFileExW.Call(uintptr(unsafe.Pointer(pattern)), findExInfoBasic, uintptr(unsafe.Pointer(data)), findExSearchNameMatch, 0, findExOnDiskEntriesOnly)
	if windows.Handle(r) == windows.InvalidHandle {
		if e == syscall.Errno(0) {
			e = windows.ERROR_FILE_NOT_FOUND
		}
		return 0, e
	}
	return windows.Handle(r), nil
}
