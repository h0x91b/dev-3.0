import { useEffect } from "react";
import type { TFunction } from "../i18n";
import { maybeInvitePushEnrollment } from "../utils/pushInvite";

export default function PushEnrollmentInvite({ t }: { t: TFunction }) {
	useEffect(() => {
		const timer = setTimeout(() => void maybeInvitePushEnrollment(t), 4_000);
		return () => clearTimeout(timer);
	}, [t]);

	return null;
}
