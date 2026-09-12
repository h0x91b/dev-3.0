import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "../../i18n";
import { useNarrowViewport } from "../../hooks/useNarrowViewport";
import { useOverlayLayer } from "../../utils/useOverlayLayer";
import BottomSheet from "../BottomSheet";
import TrafficIcon from "./TrafficIcon";
import {
	dayDate,
	isCalendarDay,
	localDay,
	parseRangePeriod,
	shiftDay,
} from "./traffic-period";
import { formatRangeLabel } from "./traffic-range";

type Props = {
	value: string;
	onChange: (value: string) => void;
	retentionDays: number;
};

export default function TrafficPeriodPicker(props: Props) {
	const t = useT();
	const [locale] = useLocale();
	const [open, setOpen] = useState(false);
	const narrow = useNarrowViewport(700);
	const trigger = useRef<HTMLButtonElement>(null);
	const close = () => {
		setOpen(false);
		trigger.current?.focus();
	};
	// A dragged range names itself — the trigger is the one place that says which
	// interval is on screen when it is not one of the presets.
	const dragged = parseRangePeriod(props.value);
	const label = dragged
		? formatRangeLabel(dragged, locale)
		: isCalendarDay(props.value)
		? dayDate(props.value).toLocaleDateString(locale, {
				day: "numeric",
				month: "short",
				year: "numeric",
			})
		: t(
				props.value === "hour"
					? "traffic.orbit.hour"
					: props.value === "all"
						? "traffic.orbit.loadedHistory"
						: "traffic.orbit.day",
			);
	const content = (
		<Calendar
			{...props}
			onChange={(value) => {
				props.onChange(value);
				close();
			}}
		/>
	);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="traffic-period-trigger"
				aria-label={`${t("traffic.orbit.timeWindow")}: ${label}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<TrafficIcon name="calendar" />
				<span>{label}</span>
			</button>
			{open &&
				(narrow ? (
					<BottomSheet open onClose={close} title={t("traffic.calendar.title")}>
						{content}
					</BottomSheet>
				) : (
					<CalendarPopover trigger={trigger} onClose={close}>
						{content}
					</CalendarPopover>
				))}
		</>
	);
}

function CalendarPopover({
	trigger,
	onClose,
	children,
}: {
	trigger: RefObject<HTMLButtonElement | null>;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const t = useT();
	const panel = useRef<HTMLDivElement>(null);
	useOverlayLayer(panel, {
		triggerRef: trigger,
		onDismiss: onClose,
		autoFocus: true,
	});
	const rect = trigger.current?.getBoundingClientRect();
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (
				!panel.current?.contains(event.target as Node) &&
				!trigger.current?.contains(event.target as Node)
			)
				onClose();
		};
		document.addEventListener("pointerdown", outside);
		window.addEventListener("resize", onClose);
		return () => {
			document.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", onClose);
		};
	}, [onClose, trigger]);
	return createPortal(
		<div
			ref={panel}
			role="dialog"
			aria-label={t("traffic.calendar.title")}
			className="traffic-calendar-popover"
			style={{
				right: Math.max(12, innerWidth - (rect?.right ?? innerWidth)),
				bottom: Math.max(12, innerHeight - (rect?.top ?? innerHeight) + 8),
			}}
		>
			{children}
		</div>,
		document.body,
	);
}

function Calendar({ value, onChange, retentionDays }: Props) {
	const t = useT();
	const [locale] = useLocale();
	const today = localDay(new Date());
	const minimum = shiftDay(today, -retentionDays);
	const initial = isCalendarDay(value) ? value : today;
	const [focused, setFocused] = useState(initial);
	const [month, setMonth] = useState(initial.slice(0, 7));
	const grid = useRef<HTMLDivElement>(null);
	const first = dayDate(`${month}-01`);
	const offset = (first.getDay() + 6) % 7;
	const count = new Date(
		first.getFullYear(),
		first.getMonth() + 1,
		0,
	).getDate();
	const moveMonth = (delta: number) => {
		const date = new Date(first.getFullYear(), first.getMonth() + delta, 1);
		setMonth(localDay(date).slice(0, 7));
		const candidate =
			localDay(date) < minimum
				? minimum
				: localDay(date) > today
					? today
					: localDay(date);
		setFocused(candidate);
	};
	const moveFocus = (day: string) => {
		const next = day < minimum ? minimum : day > today ? today : day;
		setMonth(next.slice(0, 7));
		setFocused(next);
		requestAnimationFrame(() =>
			grid.current
				?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)
				?.focus(),
		);
	};
	return (
		<div className="traffic-calendar">
			<div className="traffic-calendar-presets">
				{[
					["day", "traffic.orbit.day"],
					[today, "traffic.calendar.today"],
					[shiftDay(today, -1), "traffic.calendar.yesterday"],
					["hour", "traffic.orbit.hour"],
					["all", "traffic.orbit.loadedHistory"],
				].map(([key, label]) => (
					<button
						key={key}
						type="button"
						data-overlay-autofocus={key === "day" ? true : undefined}
						aria-pressed={value === key}
						onClick={() => onChange(key)}
					>
						{t(label as Parameters<typeof t>[0])}
					</button>
				))}
			</div>
			<div className="traffic-calendar-month">
				<button
					type="button"
					aria-label={t("traffic.calendar.previousMonth")}
					disabled={month <= minimum.slice(0, 7)}
					onClick={() => moveMonth(-1)}
				>
					‹
				</button>
				<strong aria-live="polite">
					{first.toLocaleDateString(locale, { month: "long", year: "numeric" })}
				</strong>
				<button
					type="button"
					aria-label={t("traffic.calendar.nextMonth")}
					disabled={month >= today.slice(0, 7)}
					onClick={() => moveMonth(1)}
				>
					›
				</button>
			</div>
			<div className="traffic-calendar-weekdays" aria-hidden="true">
				{Array.from({ length: 7 }, (_, i) => (
					<span key={i}>
						{new Date(2026, 0, 5 + i).toLocaleDateString(locale, {
							weekday: "short",
						})}
					</span>
				))}
			</div>
			<div
				ref={grid}
				className="traffic-calendar-days"
				role="group"
				aria-label={t("traffic.calendar.title")}
				onKeyDown={(event) => {
					let day: string | null = null;
					if (event.key === "ArrowLeft") day = shiftDay(focused, -1);
					if (event.key === "ArrowRight") day = shiftDay(focused, 1);
					if (event.key === "ArrowUp") day = shiftDay(focused, -7);
					if (event.key === "ArrowDown") day = shiftDay(focused, 7);
					if (event.key === "Home")
						day = shiftDay(focused, -((dayDate(focused).getDay() + 6) % 7));
					if (event.key === "End")
						day = shiftDay(focused, 6 - ((dayDate(focused).getDay() + 6) % 7));
					if (day) {
						event.preventDefault();
						moveFocus(day);
					}
				}}
			>
				{Array.from({ length: offset }, (_, i) => (
					<span key={`blank-${i}`} />
				))}
				{Array.from({ length: count }, (_, i) => {
					const day = `${month}-${String(i + 1).padStart(2, "0")}`;
					return (
						<button
							key={day}
							type="button"
							data-day={day}
							disabled={day < minimum || day > today}
							tabIndex={focused === day ? 0 : -1}
							onFocus={() => setFocused(day)}
							aria-pressed={value === day}
							aria-current={day === today ? "date" : undefined}
							aria-label={dayDate(day).toLocaleDateString(locale, {
								dateStyle: "full",
							})}
							onClick={() => onChange(day)}
						>
							{i + 1}
						</button>
					);
				})}
			</div>
		</div>
	);
}
