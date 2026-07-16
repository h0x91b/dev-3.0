@testable import dev3
import Dev3Kit
import Dev3UI
import Foundation
import SwiftUI
import Testing
import UIKit

@Suite("Mounted task review destinations")
@MainActor
struct TaskReviewDestinationIdentityTests {
    @Test("Diff reconnect keeps the mounted store when its destination recomposes")
    func diffStoreIdentity() async throws {
        let serviceA = try IdentityDiffService(response: makeIdentityDiff())
        let serviceB = try IdentityDiffService(response: makeIdentityDiff())
        let storeA = makeDiffStore(service: serviceA)
        let storeB = makeDiffStore(service: serviceB)
        let controller = UIHostingController(
            rootView: TaskDiffDestinationHost(store: storeA, isConnected: false)
        )
        let window = mount(controller)
        defer { window.isHidden = true }
        await renderPass()

        controller.rootView = TaskDiffDestinationHost(store: storeB, isConnected: true)
        controller.view.layoutIfNeeded()
        let reconnected = await eventually {
            let requestCount = await serviceA.requestCount()
            return storeA.isConnected && requestCount > 0
        }

        #expect(reconnected)
        #expect(storeA.isConnected)
        #expect(!storeB.isConnected)
        #expect(await serviceB.requestCount() == 0)
    }

    @Test("Pull request reconnect keeps the mounted store when its destination recomposes")
    func pullRequestStoreIdentity() async throws {
        let serviceA = IdentityPRStatusService()
        let serviceB = IdentityPRStatusService()
        let storeA = try TaskPRStatusStore(
            task: makeIdentityTask(),
            isConnected: false,
            service: serviceA
        )
        let storeB = try TaskPRStatusStore(
            task: makeIdentityTask(),
            isConnected: false,
            service: serviceB
        )
        let appStore = AppStore(runtime: ConnectionRuntime())
        let controller = UIHostingController(
            rootView: TaskPRStatusDestinationHost(
                appStore: appStore,
                store: storeA,
                isConnected: false
            )
        )
        let window = mount(controller)
        defer { window.isHidden = true }
        await renderPass()

        controller.rootView = TaskPRStatusDestinationHost(
            appStore: appStore,
            store: storeB,
            isConnected: true
        )
        controller.view.layoutIfNeeded()
        let reconnected = await eventually {
            let requestCount = await serviceA.requestCount()
            return storeA.isConnected && requestCount > 0
        }

        #expect(reconnected)
        #expect(storeA.isConnected)
        #expect(!storeB.isConnected)
        #expect(await serviceB.requestCount() == 0)
    }

    private func makeDiffStore(service: IdentityDiffService) -> TaskDiffStore {
        TaskDiffStore(
            serverID: "server",
            projectID: "project",
            taskID: "task",
            compareRef: "main",
            isConnected: false,
            service: service,
            readPersistence: IdentityDiffReadStore()
        )
    }

    private func mount(
        _ controller: UIHostingController<some View>
    ) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.layoutIfNeeded()
        return window
    }

    private func renderPass() async {
        for _ in 0 ..< 20 {
            await Task.yield()
        }
    }

    private func eventually(
        _ condition: @escaping @MainActor () async -> Bool
    ) async -> Bool {
        for _ in 0 ..< 100 {
            if await condition() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
}

private actor IdentityDiffService: TaskDiffServicing {
    private let response: Dev3TaskDiff
    private var requests = 0

    init(response: Dev3TaskDiff) {
        self.response = response
    }

    func taskDiff(_: TaskDiffFetchRequest) -> Dev3TaskDiff {
        requests += 1
        return response
    }

    func requestCount() -> Int {
        requests
    }
}

private actor IdentityDiffReadStore: TaskDiffReadPersisting {
    func readSignatures(serverID _: String, taskID _: String) -> Set<String> {
        []
    }

    func setRead(
        _: Bool,
        signature _: String,
        serverID _: String,
        taskID _: String
    ) {}
}

private actor IdentityPRStatusService: TaskPRStatusServicing {
    private var requests = 0

    func refreshPRStatus(taskID _: String, projectID _: String) {
        requests += 1
    }

    func requestCount() -> Int {
        requests
    }
}

private func makeIdentityTask() throws -> Dev3Task {
    try JSONDecoder().decode(
        Dev3Task.self,
        from: Data(
            """
            {"id":"task","seq":1,"projectId":"project","title":"Review","description":"Test",
             "status":"in-progress","baseBranch":"main","createdAt":"2026-07-16T10:00:00Z",
             "updatedAt":"2026-07-16T10:00:00Z","prNumber":969}
            """.utf8
        )
    )
}

private func makeIdentityDiff() throws -> Dev3TaskDiff {
    try JSONDecoder().decode(
        Dev3TaskDiff.self,
        from: Data(
            """
            {"mode":"uncommitted","compareRef":null,"compareLabel":"Working tree","files":[],
             "skippedFiles":[],"summary":{"files":0,"insertions":0,"deletions":0}}
            """.utf8
        )
    )
}
