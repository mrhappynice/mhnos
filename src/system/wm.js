// src/system/wm.js

// FIX: Start at 500 to ensure windows appear ABOVE the Shell (which is z-index 200)
let zIndexCounter = 500; 

export class WindowManager {
    constructor(desktopId) {
        this.desktop = document.getElementById(desktopId);
        this.minimizeDock = document.getElementById('minimize-dock');
        this.windows = [];
        this.isDragging = false;
        
        window.addEventListener('mouseup', () => this.stopDrag());
        window.addEventListener('mousemove', (e) => this.onDrag(e));
        window.addEventListener('resize', () => this.onViewportResize());
    }

    createWindow(title, contentElement, options = {}) {
        const id = 'win-' + Date.now();
        const width = options.width || 400;
        const height = options.height || 300;
        
        // Default to center if no X/Y provided
        const x = options.x || (window.innerWidth - width) / 2;
        const y = options.y || (window.innerHeight - height) / 2;

        const win = document.createElement('div');
        win.className = 'window';
        win.id = id;
        win.dataset.title = title;
        win.style.width = width + 'px';
        win.style.height = height + 'px';
        win.style.left = x + 'px';
        win.style.top = y + 'px';
        
        // Assign High Z-Index
        win.style.zIndex = ++zIndexCounter;

        win.innerHTML = `
            <div class="window-header">
                <div class="window-title">${title}</div>
                <div class="window-controls">
                    <button class="btn-min"></button>
                    <button class="btn-max"></button>
                    <button class="btn-close"></button>
                </div>
            </div>
            <div class="window-body"></div>
        `;

        const body = win.querySelector('.window-body');
        body.appendChild(contentElement);

        const header = win.querySelector('.window-header');
        header.addEventListener('mousedown', (e) => this.startDrag(e, win));
        win.addEventListener('mousedown', () => this.focus(win));
        
        win.querySelector('.btn-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeWindow(win);
        });
        win.querySelector('.btn-min').addEventListener('click', (e) => {
            e.stopPropagation();
            this.minimizeWindow(win);
        });
        win.querySelector('.btn-max').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMaximize(win);
        });

        this.desktop.appendChild(win);
        this.windows.push(win);
        
        // Log for debugging
        console.log(`[WM] Created window: ${title} at z-index ${win.style.zIndex}`);
        
        return win;
    }

    focus(win) {
        if (win.classList.contains('minimized')) return;
        // Bring to front
        win.style.zIndex = ++zIndexCounter;
        this.windows.forEach(w => w.classList.remove('active'));
        win.classList.add('active');
    }

    closeWindow(win) {
        if (win && win._minIcon) {
            win._minIcon.remove();
            win._minIcon = null;
        }
        if (win && win.parentNode) {
            win.parentNode.removeChild(win);
        }
        this.windows = this.windows.filter(w => w !== win);
    }

    startDrag(e, win) {
        if (win.classList.contains('maximized')) return;
        if (e.target.closest('.window-controls')) return;
        this.isDragging = true;
        this.dragTarget = win;
        this.focus(win);
        const rect = win.getBoundingClientRect();
        this.dragOffsetX = e.clientX - rect.left;
        this.dragOffsetY = e.clientY - rect.top;
    }

    onDrag(e) {
        if (!this.isDragging || !this.dragTarget) return;
        e.preventDefault();
        const x = e.clientX - this.dragOffsetX;
        const y = e.clientY - this.dragOffsetY;
        this.dragTarget.style.left = x + 'px';
        this.dragTarget.style.top = y + 'px';
    }

    stopDrag() {
        this.isDragging = false;
        this.dragTarget = null;
    }

    minimizeWindow(win) {
        if (!win || win.classList.contains('minimized')) return;
        const icon = document.createElement('button');
        icon.type = 'button';
        icon.className = 'minimized-icon';
        const title = win.dataset.title || 'App';
        icon.textContent = title.trim().charAt(0).toUpperCase();
        icon.title = title;
        icon.addEventListener('click', () => this.restoreWindow(win));
        if (this.minimizeDock) {
            this.minimizeDock.appendChild(icon);
        }
        win._minIcon = icon;
        win.classList.add('minimized');
        win.style.display = 'none';
    }

    restoreWindow(win) {
        if (!win || !win.classList.contains('minimized')) return;
        win.classList.remove('minimized');
        win.style.display = '';
        if (win._minIcon) {
            win._minIcon.remove();
            win._minIcon = null;
        }
        this.focus(win);
    }

    toggleMaximize(win) {
        if (!win) return;
        if (win.classList.contains('maximized')) {
            const restore = win.dataset.restore
                ? JSON.parse(win.dataset.restore)
                : null;
            if (restore) {
                win.style.left = restore.left;
                win.style.top = restore.top;
                win.style.width = restore.width;
                win.style.height = restore.height;
            }
            win.classList.remove('maximized');
            return;
        }
        const restore = {
            left: win.style.left,
            top: win.style.top,
            width: win.style.width,
            height: win.style.height
        };
        win.dataset.restore = JSON.stringify(restore);
        win.classList.add('maximized');
        win.style.left = '0px';
        win.style.top = '0px';
        win.style.width = window.innerWidth + 'px';
        win.style.height = window.innerHeight + 'px';
        this.focus(win);
    }

    onViewportResize() {
        this.windows.forEach(win => {
            if (!win.classList.contains('maximized')) return;
            win.style.left = '0px';
            win.style.top = '0px';
            win.style.width = window.innerWidth + 'px';
            win.style.height = window.innerHeight + 'px';
        });
    }
}
