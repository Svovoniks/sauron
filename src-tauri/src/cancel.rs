//! Per-query cancellation.
//!
//! Every execution registers one `ActiveQuery` before it does anything (including connecting)
//! and removes it when it finishes. `cancel_query` only ever touches the query that is running
//! right now, so a cancel can never leak into a later query.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::model::CANCELLED;

/// How to stop the server-side work of a running query.
pub enum Killer {
    Postgres {
        token: tokio_postgres::CancelToken,
        tls: postgres_native_tls::MakeTlsConnector,
    },
    ClickHouse(crate::clickhouse::Kill),
}

struct Active {
    id: u64,
    notify: Arc<Notify>,
    killer: Option<Killer>,
}

#[derive(Default)]
pub struct Registry {
    active: Mutex<Option<Active>>,
    next_id: AtomicU64,
}

impl Registry {
    pub fn begin(&self) -> Guard<'_> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let notify = Arc::new(Notify::new());
        *self.active.lock().unwrap() = Some(Active {
            id,
            notify: notify.clone(),
            killer: None,
        });
        Guard {
            registry: self,
            id,
            notify,
        }
    }

    /// Stop the running query, if any. Does nothing when nothing is running.
    pub async fn cancel(&self) {
        let active = self.active.lock().unwrap().take();
        let Some(active) = active else { return };

        // Stop waiting first so the UI is released immediately, then stop the server-side work.
        active.notify.notify_one();
        match active.killer {
            Some(Killer::Postgres { token, tls }) => {
                let _ = token.cancel_query(tls).await;
            }
            Some(Killer::ClickHouse(kill)) => kill.send().await,
            None => {}
        }
    }
}

pub struct Guard<'a> {
    registry: &'a Registry,
    id: u64,
    notify: Arc<Notify>,
}

impl Guard<'_> {
    pub fn set_killer(&self, killer: Killer) {
        let mut active = self.registry.active.lock().unwrap();
        if let Some(active) = active.as_mut().filter(|a| a.id == self.id) {
            active.killer = Some(killer);
        }
    }

    /// Run `work`, aborting it (and dropping its connection) as soon as the query is cancelled.
    pub async fn run<T>(&self, work: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        tokio::select! {
            _ = self.notify.notified() => Err(CANCELLED.to_string()),
            result = work => result,
        }
    }
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let mut active = self.registry.active.lock().unwrap();
        if active.as_ref().is_some_and(|a| a.id == self.id) {
            *active = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_without_running_query_is_a_noop_and_does_not_leak() {
        let registry = Registry::default();
        registry.cancel().await;

        // A later query must not see the earlier cancel.
        let guard = registry.begin();
        let result = guard.run(async { Ok::<_, String>(42) }).await;
        assert_eq!(result, Ok(42));
    }

    #[tokio::test]
    async fn cancel_interrupts_the_running_query() {
        let registry = Registry::default();
        let guard = registry.begin();

        let (result, _) = tokio::join!(
            guard.run(async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok::<_, String>(())
            }),
            async {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                registry.cancel().await;
            }
        );
        assert_eq!(result, Err(CANCELLED.to_string()));
    }

    #[tokio::test]
    async fn cancel_before_the_work_starts_waiting_still_wins() {
        let registry = Registry::default();
        let guard = registry.begin();
        registry.cancel().await;
        let result = guard
            .run(async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok::<_, String>(())
            })
            .await;
        assert_eq!(result, Err(CANCELLED.to_string()));
    }

    #[tokio::test]
    async fn finished_query_is_unregistered() {
        let registry = Registry::default();
        {
            let _guard = registry.begin();
        }
        assert!(registry.active.lock().unwrap().is_none());
    }
}
