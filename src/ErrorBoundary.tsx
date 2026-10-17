// A screen that crashes shows what went wrong and a way out, instead of a blank page.

import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="menu-app">
        <main className="screen">
          <div className="card" role="alert">
            <h1>Màn hình này gặp lỗi</h1>
            <p>Chụp lại dòng dưới đây gửi cho người cài app, rồi bấm Tải lại.</p>
            <p className="field-error block">{error.message || String(error)}</p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
                Tải lại
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  location.hash = '#/ban'
                  this.setState({ error: null })
                }}
              >
                Về trang Bàn
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }
}
