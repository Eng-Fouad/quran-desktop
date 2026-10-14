//! The read pool of a [`super::PackDb`]: r2d2 over [`SqliteConnectionManager`], with every connection counted, so that
//! dropping the last handle returns only once the pack's file is closed.
//!
//! r2d2 opens connections on its worker thread, which keeps the pool alive for a moment after handing a new connection
//! over. A pool whose last handle is dropped in that moment is freed by the worker a little later, idle connections
//! included, so the file stayed open after the handle was gone. Windows refuses to delete or rename a file SQLite has
//! open: a flip or a removal right after releasing the handle failed now and then with "The process cannot access the
//! file because it is being used by another process" (os error 32).

use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

/// How long the last handle's drop waits for r2d2 to close the connections (it takes microseconds).
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// The number of a pool's connections that are open or being opened.
#[derive(Debug, Default)]
pub(super) struct OpenConns {
    count: Mutex<usize>,
    closed: Condvar,
}

impl OpenConns {
    fn opening(self: &Arc<Self>) -> Counted {
        *self.count.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        Counted(Arc::clone(self))
    }

    /// Waits until no connection is open, at most `timeout`; whether none is.
    pub(super) fn wait_closed(&self, timeout: Duration) -> bool {
        let count = self.count.lock().unwrap_or_else(PoisonError::into_inner);
        let (count, _) = self
            .closed
            .wait_timeout_while(count, timeout, |n| *n > 0)
            .unwrap_or_else(PoisonError::into_inner);
        *count == 0
    }
}

/// One open connection of [`OpenConns`].
struct Counted(Arc<OpenConns>);

impl Drop for Counted {
    fn drop(&mut self) {
        let mut count = self.0.count.lock().unwrap_or_else(PoisonError::into_inner);
        *count = count.saturating_sub(1);
        if *count == 0 {
            self.0.closed.notify_all();
        }
    }
}

/// A pooled pack connection (derefs to the [`Connection`]).
pub(super) struct PackConn {
    conn: Connection,
    /// Declared after `conn`, so dropped after it: counted closed once the file is.
    _open: Counted,
}

impl Deref for PackConn {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

impl DerefMut for PackConn {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

/// [`SqliteConnectionManager`] whose connections are counted in [`OpenConns`].
pub(super) struct Manager {
    inner: SqliteConnectionManager,
    open: Arc<OpenConns>,
}

impl Manager {
    pub(super) fn new(inner: SqliteConnectionManager, open: Arc<OpenConns>) -> Self {
        Self { inner, open }
    }
}

impl r2d2::ManageConnection for Manager {
    type Connection = PackConn;
    type Error = rusqlite::Error;

    fn connect(&self) -> Result<PackConn, rusqlite::Error> {
        let open = self.open.opening();
        Ok(PackConn {
            conn: self.inner.connect()?,
            _open: open,
        })
    }

    fn is_valid(&self, conn: &mut PackConn) -> Result<(), rusqlite::Error> {
        self.inner.is_valid(&mut conn.conn)
    }

    fn has_broken(&self, conn: &mut PackConn) -> bool {
        self.inner.has_broken(&mut conn.conn)
    }
}

/// Shared by the clones of a [`super::PackDb`] and declared after its pool, so it drops after the last pool handle:
/// then it waits for r2d2 to close the connections.
pub(super) struct Closer(pub(super) Arc<OpenConns>);

impl Drop for Closer {
    fn drop(&mut self) {
        if !self.0.wait_closed(CLOSE_WAIT) {
            log::warn!(
                "pack db: a connection is still open {CLOSE_WAIT:?} after the last handle was dropped"
            );
        }
    }
}
