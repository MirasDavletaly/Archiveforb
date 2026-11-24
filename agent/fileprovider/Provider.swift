// Company Files in Finder, like OneDrive: a File Provider extension (macOS 12 and later) inside the app. It shows the
// website's tree (the places of the sidebar, no confidential folders), downloads a file when it is opened, and sends
// what is made, edited, renamed, moved or deleted here to the website, with the website's rules. What changes on the
// website comes through the server's change log (the app signals when to look). The server address and this
// computer's token are in the folder the app and this extension share (the app writes provider.json there).

import FileProvider
import Foundation
import os
import UniformTypeIdentifiers

// In the system log: log show --predicate 'subsystem == "com.companyfiles.provider"' (the token is never logged)
let logger = Logger(subsystem: "com.companyfiles.provider", category: "provider")

// MARK: - the website

struct Entry: Decodable {
    let id: Int64
    let name: String
    let dir: Bool
    let size: Int64
    let v: String
    let modified: Double
    let created: Double
    let readOnly: Bool
    let parent: Int64?
    let place: Bool? // a place of the top level (My files, a department...): it stays where it is
}

struct Changes: Decodable {
    let anchor: Int64
    let more: Bool?
    let reset: Bool?
    let items: [Entry]?
    let deleted: [Int64]?
}

struct APIError: Error {
    let status: Int
    let message: String
}

struct Shared: Decodable {
    let server: String
    let token: String
}

final class API {
    static let shared = API()
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 24 * 3600
        return URLSession(configuration: c)
    }()

    static var group: String { Bundle.main.object(forInfoDictionaryKey: "CompanyFilesAppGroup") as? String ?? "" }

    // "provider-ok" in the shared folder: the app checks it to know this extension really works (else it falls back
    // to the network drive). Written at most once a minute.
    private let okLock = NSLock()
    private var okAt = Date.distantPast
    func markOK() {
        okLock.lock()
        let due = Date().timeIntervalSince(okAt) > 60
        if due { okAt = Date() }
        okLock.unlock()
        guard due, let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: API.group) else { return }
        try? Data(String(Date().timeIntervalSince1970).utf8).write(to: dir.appendingPathComponent("provider-ok"), options: .atomic)
    }

    // Read for every call: the app rewrites it when this computer is connected again or disconnected.
    private func shared() throws -> Shared {
        let group = API.group
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            logger.error("no shared folder for group \(group, privacy: .public)")
            throw NSFileProviderError(.notAuthenticated)
        }
        let file = dir.appendingPathComponent("provider.json")
        do {
            let s = try JSONDecoder().decode(Shared.self, from: Data(contentsOf: file))
            if s.token.isEmpty { throw NSFileProviderError(.notAuthenticated) }
            return s
        } catch {
            logger.error("cannot read \(file.path, privacy: .public): \(String(describing: error), privacy: .public)")
            throw NSFileProviderError(.notAuthenticated)
        }
    }

    private func request(_ method: String, _ path: String, _ query: [String: String] = [:]) throws -> URLRequest {
        let s = try shared()
        var u = URLComponents(string: s.server + path)!
        if !query.isEmpty { u.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var r = URLRequest(url: u.url!)
        r.httpMethod = method
        r.setValue("Bearer " + s.token, forHTTPHeaderField: "Authorization")
        r.setValue("CompanyFiles-FileProvider", forHTTPHeaderField: "User-Agent")
        return r
    }

    private func check(_ data: Data, _ resp: URLResponse) throws -> Data {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? ""
            throw APIError(status: status, message: msg)
        }
        return data
    }

    func json<T: Decodable>(_ method: String, _ path: String, _ query: [String: String] = [:], as type: T.Type) async throws -> T {
        do {
            let (data, resp) = try await session.data(for: try request(method, path, query))
            let out = try JSONDecoder().decode(T.self, from: try check(data, resp))
            markOK()
            return out
        } catch {
            logger.error("\(method, privacy: .public) \(path, privacy: .public): \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    func top() async throws -> [Entry] { try await json("GET", "/api/agent/cloud", as: [Entry].self) }
    // Whether things may be put at the top level (only for "My files at the top", where they go into My files).
    func topHoldsFiles() async -> Bool {
        guard let r = try? request("GET", "/api/agent/cloud"), let answer = try? await session.data(for: r) else { return false }
        return (answer.1 as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Top-Holds-Files") == "1"
    }
    func children(_ id: Int64) async throws -> [Entry] { try await json("GET", "/api/agent/cloud/\(id)", as: [Entry].self) }
    func info(_ id: Int64) async throws -> Entry { try await json("GET", "/api/agent/cloud/\(id)/info", as: Entry.self) }
    func changes(since: Int64?) async throws -> Changes {
        try await json("GET", "/api/agent/cloud-changes", since.map { ["since": String($0)] } ?? [:], as: Changes.self)
    }
    func folder(in parent: Int64, name: String) async throws -> Entry {
        try await json("POST", "/api/agent/cloud/\(parent)/folders", ["name": name], as: Entry.self)
    }
    func move(_ id: Int64, _ query: [String: String]) async throws -> Entry {
        try await json("POST", "/api/agent/cloud/\(id)/move", query, as: Entry.self)
    }
    func delete(_ id: Int64) async throws {
        let (data, resp) = try await session.data(for: try request("DELETE", "/api/agent/cloud/\(id)"))
        _ = try check(data, resp)
    }

    // A new file (name=) or a new version of one (id= and base=, the version it was based on) in a folder.
    func upload(to folder: Int64, _ query: [String: String], file: URL?) async throws -> Entry {
        var r = try request("PUT", "/api/agent/cloud/\(folder)/files", query)
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, resp) = file != nil ? try await session.upload(for: r, fromFile: file!) : try await session.upload(for: r, from: Data())
        return try JSONDecoder().decode(Entry.self, from: try check(data, resp))
    }

    func download(_ id: Int64, to dest: URL) async throws {
        let (tmp, resp) = try await session.download(for: try request("GET", "/api/agent/cloud/\(id)/content"))
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            try? FileManager.default.removeItem(at: tmp)
            throw APIError(status: status, message: "")
        }
        try FileManager.default.moveItem(at: tmp, to: dest)
    }
}

// What the system understands: errors of the File Provider kind.
func fpError(_ e: Error) -> Error {
    if let a = e as? APIError {
        switch a.status {
        case 401: return NSFileProviderError(.notAuthenticated)
        case 404: return NSFileProviderError(.noSuchItem)
        case 409: return NSFileProviderError(.filenameCollision)
        case 413, 507: return NSFileProviderError(.insufficientQuota)
        case 400, 403: return CocoaError(.fileWriteNoPermission)
        default: return NSFileProviderError(.serverUnreachable)
        }
    }
    if e is URLError { return NSFileProviderError(.serverUnreachable) }
    return e
}

// MARK: - kept on this Mac

// "Always Keep on This Device" and "Free Up Space", as on Windows. The ids kept are in the shared folder
// (pins.json). A kept item, and everything inside a kept folder, is downloaded at once, kept current and never
// removed by the system: its content policy (macOS 13 and later; on macOS 12 it is only marked, and downloaded when
// opened). A change is told to the system through the working set (pending), so Finder's menu and badges follow.
final class Pins {
    static let shared = Pins()
    private let lock = NSLock()
    private var ids: Set<Int64>?
    private var pending = Set<Int64>()
    private var dir: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: API.group) }

    private func load() -> Set<Int64> { // with the lock held
        if let ids { return ids }
        let read = dir.flatMap { try? JSONDecoder().decode([Int64].self, from: Data(contentsOf: $0.appendingPathComponent("pins.json"))) } ?? []
        ids = Set(read)
        return ids!
    }

    func contains(_ id: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return load().contains(id)
    }

    func set(_ changed: [Int64], keep: Bool) {
        lock.lock(); defer { lock.unlock() }
        var s = load()
        for id in changed { if keep { s.insert(id) } else { s.remove(id) } }
        ids = s
        pending.formUnion(changed)
        if let d = dir { try? JSONEncoder().encode(s.sorted()).write(to: d.appendingPathComponent("pins.json"), options: .atomic) }
    }

    func takePending() -> [Int64] {
        lock.lock(); defer { lock.unlock() }
        defer { pending.removeAll() }
        return Array(pending)
    }

    // The same two commands asked by the app (`CompanyFiles fp-keep|fp-free <id>…`, used by the tests): requests.json
    // in the shared folder, taken once.
    func takeRequests() -> [(id: Int64, keep: Bool)] {
        struct Request: Decodable { let id: Int64; let keep: Bool }
        guard let file = dir?.appendingPathComponent("requests.json"), let data = try? Data(contentsOf: file) else { return [] }
        try? FileManager.default.removeItem(at: file)
        return ((try? JSONDecoder().decode([Request].self, from: data)) ?? []).map { ($0.id, $0.keep) }
    }
}

// Keep (download now, never remove) or free up space (remove the download; the file stays on the website).
func setKeep(_ domain: NSFileProviderDomain, _ ids: [Int64], keep: Bool) async {
    guard !ids.isEmpty, let m = NSFileProviderManager(for: domain) else { return }
    Pins.shared.set(ids, keep: keep)
    logger.notice("\(keep ? "keep" : "free up", privacy: .public) \(ids.count) item(s)")
    try? await m.signalEnumerator(for: .workingSet) // the system learns the new state: menu, badge, content policy
    guard !keep else { return } // the content policy has the system download it and keep it
    for id in ids {
        // A kept item cannot be removed until the system has its new policy: a few tries.
        for attempt in 1...5 {
            do {
                try await m.evictItem(identifier: identifier(id))
                break
            } catch {
                if attempt == 5 { logger.error("free up \(id): \(String(describing: error), privacy: .public)") }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
}

// MARK: - items

func identifier(_ id: Int64) -> NSFileProviderItemIdentifier { NSFileProviderItemIdentifier("n\(id)") }

func nodeID(_ i: NSFileProviderItemIdentifier) -> Int64? {
    i.rawValue.hasPrefix("n") ? Int64(i.rawValue.dropFirst()) : nil
}

// The website folder something is put into; 0 is the top level (the website takes it only for "My files at the top").
func folderID(_ i: NSFileProviderItemIdentifier) -> Int64? { i == .rootContainer ? 0 : nodeID(i) }

// Finder's own files, programs' temporary files and Office lock files stay on this computer only.
func localOnly(_ name: String) -> Bool { name.hasPrefix(".") || name.hasPrefix("~$") || name == "Icon\r" }

final class Item: NSObject, NSFileProviderItem {
    let e: Entry
    let parent: NSFileProviderItemIdentifier
    let kept: Bool

    init(_ e: Entry, parent: NSFileProviderItemIdentifier) {
        self.e = e
        self.parent = parent
        self.kept = Pins.shared.contains(e.id)
    }

    convenience init(_ e: Entry) { // with the parent the server gave (0 = the top level)
        self.init(e, parent: (e.parent ?? 0) == 0 ? .rootContainer : identifier(e.parent!))
    }

    var itemIdentifier: NSFileProviderItemIdentifier { identifier(e.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { parent }
    var filename: String { e.name }
    var contentType: UTType { e.dir ? .folder : (UTType(filenameExtension: (e.name as NSString).pathExtension) ?? .data) }
    var documentSize: NSNumber? { e.dir ? nil : NSNumber(value: e.size) }
    var contentModificationDate: Date? { Date(timeIntervalSince1970: e.modified / 1000) }
    var creationDate: Date? { Date(timeIntervalSince1970: e.created / 1000) }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data((e.dir ? "dir" : e.v).utf8),
                                  metadataVersion: Data("\(e.name)|\(parent.rawValue)|\(e.modified)|\(e.readOnly)|\(kept)".utf8))
    }
    // Finder's menu shows "Always Keep on This Device" for items not kept (Info.plist activation rule).
    var userInfo: [AnyHashable: Any]? { kept ? ["keep": true] : nil }
    @available(macOS 13.0, *)
    var contentPolicy: NSFileProviderContentPolicy { kept ? .downloadEagerlyAndKeepDownloaded : .inherited }
    var capabilities: NSFileProviderItemCapabilities {
        // allowsEvicting: the download can be removed (Finder's "Remove Download", "Free Up Space"); macOS 12 needs
        // it, later versions go by the content policy
        var c: NSFileProviderItemCapabilities = e.dir ? [.allowsReading, .allowsContentEnumerating, .allowsEvicting] : [.allowsReading, .allowsEvicting]
        if !e.readOnly {
            c.insert(e.dir ? .allowsAddingSubItems : .allowsWriting)
            if e.place != true { c.formUnion([.allowsRenaming, .allowsReparenting, .allowsDeleting]) } // the places stay
        }
        return c
    }
}

// The top level takes new items only for "My files at the top" (they go into My files); for anyone else Finder does
// not offer it, so nothing ends up here unsynced.
final class RootItem: NSObject, NSFileProviderItem {
    let holdsFiles: Bool
    init(holdsFiles: Bool) { self.holdsFiles = holdsFiles }
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { "Company Files" }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { holdsFiles ? [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems] : [.allowsReading, .allowsContentEnumerating] }
    var itemVersion: NSFileProviderItemVersion { NSFileProviderItemVersion(contentVersion: Data("root".utf8), metadataVersion: Data("root|\(holdsFiles)".utf8)) }
}

// MARK: - the extension

@objc(CFFileProviderExtension)
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    let api = API.shared

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        super.init()
        logger.notice("started for domain \(domain.identifier.rawValue, privacy: .public)")
        Task { _ = try? await API.shared.changes(since: nil) } // reach the website once at start: the app sees it works
    }

    func invalidate() {}

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        Task {
            if identifier == .rootContainer { return completionHandler(RootItem(holdsFiles: await api.topHoldsFiles()), nil) }
            guard let id = nodeID(identifier) else { return completionHandler(nil, NSFileProviderError(.noSuchItem)) }
            do { completionHandler(Item(try await api.info(id)), nil) } catch { completionHandler(nil, fpError(error)) }
        }
        return Progress()
    }

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest, completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            guard let id = nodeID(itemIdentifier) else { return completionHandler(nil, nil, NSFileProviderError(.noSuchItem)) }
            do {
                let dir = (try? NSFileProviderManager(for: domain)?.temporaryDirectoryURL()) ?? FileManager.default.temporaryDirectory
                let dest = dir.appendingPathComponent(UUID().uuidString)
                let e = try await api.info(id)
                try await api.download(id, to: dest)
                progress.completedUnitCount = 1
                completionHandler(dest, Item(e), nil)
            } catch {
                completionHandler(nil, nil, fpError(error))
            }
        }
        return progress
    }

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        Task {
            let name = itemTemplate.filename
            if localOnly(name) {
                if #available(macOS 13.0, *) { return completionHandler(nil, [], false, NSFileProviderError(.excludedFromSync)) }
                return completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
            }
            guard let parent = folderID(itemTemplate.parentItemIdentifier) else {
                return completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
            }
            do {
                let isDir = itemTemplate.contentType?.conforms(to: .folder) ?? false
                let e = isDir ? try await api.folder(in: parent, name: name) : try await api.upload(to: parent, ["name": name], file: url)
                completionHandler(Item(e, parent: itemTemplate.parentItemIdentifier), [], false, nil)
            } catch {
                completionHandler(nil, [], false, fpError(error))
            }
        }
        return Progress()
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                    contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        Task {
            guard let id = nodeID(item.itemIdentifier) else { return completionHandler(nil, [], false, NSFileProviderError(.noSuchItem)) }
            do {
                var entry: Entry?
                if changedFields.contains(.filename) || changedFields.contains(.parentItemIdentifier) {
                    var q = ["name": item.filename]
                    if changedFields.contains(.parentItemIdentifier) {
                        guard let p = folderID(item.parentItemIdentifier) else { return completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission)) }
                        q["parent"] = String(p)
                    }
                    entry = try await api.move(id, q)
                }
                if changedFields.contains(.contents), let url = newContents, let folder = folderID(item.parentItemIdentifier) {
                    let base = String(decoding: version.contentVersion, as: UTF8.self)
                    do {
                        entry = try await api.upload(to: folder, ["id": String(id), "base": base], file: url)
                    } catch let a as APIError where a.status == 409 {
                        // Changed on the website meanwhile: this edit is kept as "name (conflict, Mac)" beside it, and
                        // the website's version comes back under the name.
                        let ext = (item.filename as NSString).pathExtension
                        let stem = (item.filename as NSString).deletingPathExtension
                        _ = try await api.upload(to: folder, ["name": "\(stem) (conflict, Mac)" + (ext.isEmpty ? "" : ".\(ext)")], file: url)
                        return completionHandler(Item(try await api.info(id)), [], true, nil)
                    }
                }
                let e: Entry
                if let entry { e = entry } else { e = try await api.info(id) }
                // a move or upload answer has no parent: it is where the system just put it
                completionHandler(e.parent == nil ? Item(e, parent: item.parentItemIdentifier) : Item(e), [], false, nil)
            } catch {
                completionHandler(nil, [], false, fpError(error))
            }
        }
        return Progress()
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        Task {
            guard let id = nodeID(identifier) else { return completionHandler(NSFileProviderError(.noSuchItem)) }
            do {
                try await api.delete(id) // to the website's trash
                completionHandler(nil)
            } catch let a as APIError where a.status == 404 {
                completionHandler(nil) // gone already
            } catch let a as APIError where a.status == 403 {
                completionHandler(NSFileProviderError(.deletionRejected))
            } catch {
                completionHandler(fpError(error))
            }
        }
        return Progress()
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        Enumerator(containerItemIdentifier, domain: domain)
    }
}

// Finder's "Always Keep on This Device" and "Free Up Space" (declared in Info.plist: NSExtensionFileProviderActions).
extension FileProviderExtension: NSFileProviderCustomAction {
    func performAction(identifier actionIdentifier: NSFileProviderExtensionActionIdentifier, onItemsWithIdentifiers itemIdentifiers: [NSFileProviderItemIdentifier],
                       completionHandler: @escaping (Error?) -> Void) -> Progress {
        let keep = actionIdentifier.rawValue == "com.companyfiles.keep"
        let ids = itemIdentifiers.compactMap(nodeID) // the root is neither kept nor freed
        Task {
            await setKeep(domain, ids, keep: keep)
            completionHandler(nil)
        }
        return Progress()
    }
}

// MARK: - listing

final class Enumerator: NSObject, NSFileProviderEnumerator {
    let container: NSFileProviderItemIdentifier
    let domain: NSFileProviderDomain
    let api = API.shared

    init(_ container: NSFileProviderItemIdentifier, domain: NSFileProviderDomain) {
        self.container = container
        self.domain = domain
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        logger.notice("listing \(self.container.rawValue, privacy: .public)")
        Task {
            do {
                switch container {
                case .workingSet: break // what changes reaches the system through the change log below
                case .rootContainer: observer.didEnumerate(try await api.top().map { Item($0, parent: .rootContainer) })
                default:
                    guard let id = nodeID(container) else { throw NSFileProviderError(.noSuchItem) }
                    observer.didEnumerate(try await api.children(id).map { Item($0, parent: container) })
                }
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(fpError(error))
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            guard container == .workingSet else { return observer.finishEnumeratingChanges(upTo: anchor, moreComing: false) }
            // keep / free up asked by the app: handled apart (it signals again, and its items come then)
            let asked = Pins.shared.takeRequests()
            if !asked.isEmpty {
                let domain = self.domain
                Task {
                    await setKeep(domain, asked.filter { $0.keep }.map { $0.id }, keep: true)
                    await setKeep(domain, asked.filter { !$0.keep }.map { $0.id }, keep: false)
                }
            }
            do {
                // the anchor is "<change log point>" or, after a keep/free-up here, "<point>.<time>" (always new)
                let since = Int64(String(decoding: anchor.rawValue, as: UTF8.self).split(separator: ".").first ?? "") ?? 0
                let ch = try await api.changes(since: since)
                if ch.reset == true { return observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired)) }
                var items = (ch.items ?? []).map { Item($0) }
                // kept or freed up here since the last look: as they are now, with their new state
                let changedHere = Pins.shared.takePending().filter { id in !items.contains { $0.e.id == id } }
                for id in changedHere { if let e = try? await api.info(id) { items.append(Item(e)) } }
                if !items.isEmpty { observer.didUpdate(items) }
                if let gone = ch.deleted, !gone.isEmpty { observer.didDeleteItems(withIdentifiers: gone.map(identifier)) }
                let point = changedHere.isEmpty ? "\(ch.anchor)" : "\(ch.anchor).\(Int64(Date().timeIntervalSince1970 * 1000))"
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(Data(point.utf8)), moreComing: ch.more == true)
            } catch {
                observer.finishEnumeratingWithError(fpError(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task {
            let a = try? await api.changes(since: nil).anchor
            completionHandler(a.map { NSFileProviderSyncAnchor(Data(String($0).utf8)) })
        }
    }
}
