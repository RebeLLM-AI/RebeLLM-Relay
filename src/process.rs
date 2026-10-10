//! What the relay process costs: memory, CPU time and how late its runtime runs.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// The system allocator, counting the bytes in use: the relay's heap figure.
pub struct CountingAlloc;

// SAFETY: every call goes to `System` unchanged; the counters are only read for statistics.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        ALLOCATED.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, p: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, layout, new_size) };
        if !q.is_null() {
            if new_size >= layout.size() {
                let now = ALLOCATED.fetch_add(new_size - layout.size(), Ordering::Relaxed) + new_size - layout.size();
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                ALLOCATED.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        q
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProcessStats {
    pub uptime_sec: u64,
    pub rss_bytes: u64,
    /// Bytes allocated now, and the most at any time; 0 without the counting allocator.
    pub heap_used_bytes: u64,
    pub heap_peak_bytes: u64,
    pub cpu_user_us: u64,
    pub cpu_system_us: u64,
}

#[cfg(unix)]
fn cpu_times() -> (u64, u64) {
    // SAFETY: getrusage fills the struct it is given; zeroed is a valid start for it.
    let usage = unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        usage
    };
    let us = |t: libc::timeval| t.tv_sec as u64 * 1_000_000 + t.tv_usec as u64;
    (us(usage.ru_utime), us(usage.ru_stime))
}

#[cfg(windows)]
fn cpu_times() -> (u64, u64) {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: the four out-pointers are valid for the call, and the handle is the process's own.
    let ok = unsafe { GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited, &mut kernel, &mut user) };
    if ok == 0 {
        return (0, 0);
    }
    // FILETIME counts 100 ns.
    let us = |t: FILETIME| ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) / 10;
    (us(user), us(kernel))
}

#[cfg(not(any(unix, windows)))]
fn cpu_times() -> (u64, u64) {
    (0, 0)
}

pub fn process_stats(started_ms: u64) -> ProcessStats {
    let (cpu_user_us, cpu_system_us) = cpu_times();
    ProcessStats {
        uptime_sec: (crate::util::now_ms().saturating_sub(started_ms) + 500) / 1000,
        rss_bytes: memory_stats::memory_stats().map_or(0, |m| m.physical_mem as u64),
        heap_used_bytes: ALLOCATED.load(Ordering::Relaxed) as u64,
        heap_peak_bytes: PEAK.load(Ordering::Relaxed) as u64,
        cpu_user_us,
        cpu_system_us,
    }
}

/// Sampling interval of the lag, in ms; the Node.js relay sampled its event loop as often.
pub const LAG_RESOLUTION_MS: u64 = 20;
const MAX_SAMPLES: usize = 100_000;

/// How late a timer on the runtime fires: the relay's counterpart of event-loop lag.
#[derive(Clone, Default)]
pub struct LagSampler {
    samples: Arc<Mutex<Vec<u32>>>,
}

impl LagSampler {
    /// Starts sampling on the current Tokio runtime.
    pub fn start() -> Self {
        let sampler = Self::default();
        let samples = sampler.samples.clone();
        tokio::spawn(async move {
            let step = Duration::from_millis(LAG_RESOLUTION_MS);
            loop {
                let before = tokio::time::Instant::now();
                tokio::time::sleep(step).await;
                let late = before.elapsed().saturating_sub(step).as_millis() as u32;
                let mut s = samples.lock().unwrap_or_else(|e| e.into_inner());
                if s.len() < MAX_SAMPLES {
                    s.push(late);
                }
            }
        });
        sampler
    }

    pub fn record(&self, late_ms: u32) {
        self.samples.lock().unwrap_or_else(|e| e.into_inner()).push(late_ms);
    }

    /// The 99th percentile of the lag since the last reset, in whole ms; 0 without a sample.
    pub fn p99_ms(&self) -> u64 {
        let mut s = self.samples.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if s.is_empty() {
            return 0;
        }
        s.sort_unstable();
        let rank = (s.len() * 99).div_ceil(100).max(1);
        u64::from(s[rank - 1])
    }

    pub fn reset(&self) {
        self.samples.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lag_is_the_99th_percentile_since_the_last_reset_in_whole_ms_never_negative() {
        let lag = LagSampler::default();
        // An empty window reads no lag.
        assert_eq!(lag.p99_ms(), 0);
        for _ in 0..98 {
            lag.record(0);
        }
        lag.record(15);
        lag.record(110);
        assert_eq!(lag.p99_ms(), 15);
        lag.record(130);
        lag.record(130);
        assert_eq!(lag.p99_ms(), 130);
        lag.reset();
        assert_eq!(lag.p99_ms(), 0);
    }

    #[test]
    fn the_process_figures_are_read_from_the_system() {
        // Some work first: Windows counts CPU time in steps of several ms.
        let started = std::time::Instant::now();
        let mut x = 0u64;
        while started.elapsed() < Duration::from_millis(60) {
            x = std::hint::black_box(x.wrapping_mul(31).wrapping_add(7));
        }
        let p = process_stats(crate::util::now_ms() - 2_400);
        assert!(p.rss_bytes > 0);
        assert_eq!(p.uptime_sec, 2);
        assert!(p.cpu_user_us + p.cpu_system_us > 0);
    }

    #[tokio::test]
    async fn a_running_sampler_collects_samples() {
        let lag = LagSampler::start();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!lag.samples.lock().unwrap().is_empty());
        assert!(lag.p99_ms() < 5_000);
    }
}
