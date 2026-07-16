@testable import dev3
import Dev3Kit
import Foundation
import Testing

@Suite("Task review row reachability")
struct TaskReviewReachabilityTests {
    @Test("Changes appears only after branch status loads and then becomes navigable")
    func changesVisibility() throws {
        #expect(TaskReviewRowState.changes(branchStatus: nil, isRefreshing: false) == .hidden)
        #expect(TaskReviewRowState.changes(branchStatus: nil, isRefreshing: true) == .loading)

        let status = try JSONDecoder().decode(
            Dev3BranchStatus.self,
            from: Data(
                """
                {
                  "ahead":1,"behind":0,"canRebase":true,"insertions":4,"deletions":2,
                  "unpushed":1,"mergedByContent":false,"diffFiles":1,"diffInsertions":4,
                  "diffDeletions":2,"diffFileStats":[],"prNumber":null,"prUrl":null,
                  "mergeCompletionFingerprint":null
                }
                """.utf8
            )
        )

        #expect(TaskReviewRowState.changes(branchStatus: status, isRefreshing: false) == .navigable)
        #expect(TaskReviewRowState.changes(branchStatus: status, isRefreshing: true) == .navigable)
    }

    @Test("Pull request stays static when absent and navigates for any known PR")
    func pullRequestVisibility() {
        #expect(TaskReviewRowState.pullRequest(number: nil) == .unavailable)
        #expect(TaskReviewRowState.pullRequest(number: 969) == .navigable)
    }
}
