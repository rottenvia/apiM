"""
nohomo - API MANAGER
The smartest API manager with intelligent web search, thinking effort control, and plugins.

Run: python main.py
Build exe: pyinstaller --onefile --windowed --name nohomo main.py
"""

import flet as ft
import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

from api_client import chat_completion
from smart_search import smart_search, auto_thinking_effort, should_auto_search
from plugins import PLUGINS, build_system_prompt


# Colors
COLORS = {
    "bg_primary": "#0a0a0f",
    "bg_secondary": "#12121a",
    "bg_tertiary": "#1a1a26",
    "bg_elevated": "#22222e",
    "bg_hover": "#2a2a38",
    "border": "#2a2a3a",
    "border_light": "#3a3a4a",
    "text_primary": "#e8e8f0",
    "text_secondary": "#9898a8",
    "text_muted": "#686878",
    "accent": "#7c5cfc",
    "accent_light": "#9b7fff",
    "success": "#22c55e",
    "warning": "#f59e0b",
    "danger": "#ef4444",
    "search": "#06b6d4",
    "thinking": "#f59e0b",
}

# Storage path
DATA_DIR = Path.home() / ".nohomo"
DATA_DIR.mkdir(exist_ok=True)
SETTINGS_FILE = DATA_DIR / "settings.json"
HISTORY_FILE = DATA_DIR / "history.json"


def load_settings() -> dict:
    """Load settings from file"""
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except:
            pass
    return {
        "deepseek_key": "",
        "tavily_key": "",
        "model": "deepseek-v4-pro",
        "thinking_effort": "auto",
        "enabled_plugins": [],
    }


def save_settings(settings: dict):
    """Save settings to file"""
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))


def load_history() -> list:
    """Load chat history"""
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text())
        except:
            pass
    return []


def save_history(history: list):
    """Save chat history"""
    HISTORY_FILE.write_text(json.dumps(history[-100:], indent=2))  # Keep last 100


class NohomoApp:
    def __init__(self, page: ft.Page):
        self.page = page
        self.settings = load_settings()
        self.history = load_history()
        self.messages = []
        self.is_loading = False
        self.web_search_enabled = False
        
        self.setup_page()
        self.build_ui()
    
    def setup_page(self):
        """Configure page settings"""
        self.page.title = "nohomo - API MANAGER"
        self.page.bgcolor = COLORS["bg_primary"]
        self.page.padding = 0
        self.page.spacing = 0
        self.page.window.width = 1200
        self.page.window.height = 800
        self.page.window.min_width = 800
        self.page.window.min_height = 600
        self.page.fonts = {
            "Inter": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        }
        self.page.theme = ft.Theme(font_family="Inter")
    
    def build_ui(self):
        """Build the main UI"""
        # Sidebar
        self.sidebar = self.build_sidebar()
        
        # Main chat area
        self.chat_area = self.build_chat_area()
        
        # Main layout
        self.page.add(
            ft.Row(
                [self.sidebar, self.chat_area],
                expand=True,
                spacing=0,
            )
        )
    
    def build_sidebar(self) -> ft.Container:
        """Build sidebar"""
        return ft.Container(
            content=ft.Column(
                [
                    # Logo
                    ft.Container(
                        content=ft.Row(
                            [
                                ft.Container(
                                    content=ft.Text("nh", size=14, weight=ft.FontWeight.BOLD, color="white"),
                                    width=36,
                                    height=36,
                                    border_radius=10,
                                    gradient=ft.LinearGradient(
                                        colors=[COLORS["accent"], "#a855f7"],
                                        begin=ft.alignment.top_left,
                                        end=ft.alignment.bottom_right,
                                    ),
                                    alignment=ft.alignment.center,
                                ),
                                ft.Column(
                                    [
                                        ft.Text("nohomo", size=14, weight=ft.FontWeight.BOLD, color=COLORS["text_primary"]),
                                        ft.Text("API MANAGER", size=9, color=COLORS["text_secondary"]),
                                    ],
                                    spacing=0,
                                ),
                            ],
                            spacing=10,
                        ),
                        padding=ft.padding.all(16),
                        border=ft.border.only(bottom=ft.BorderSide(1, COLORS["border"])),
                    ),
                    
                    # New Chat Button
                    ft.Container(
                        content=ft.ElevatedButton(
                            content=ft.Row(
                                [
                                    ft.Icon(ft.icons.ADD, size=16, color=COLORS["accent_light"]),
                                    ft.Text("New Chat", size=13, color=COLORS["accent_light"]),
                                ],
                                spacing=8,
                            ),
                            style=ft.ButtonStyle(
                                bgcolor={"": f"{COLORS['accent']}15"},
                                side={"": ft.BorderSide(1, f"{COLORS['accent']}30")},
                                shape={"": ft.RoundedRectangleBorder(radius=10)},
                                padding={"": ft.padding.symmetric(horizontal=16, vertical=10)},
                            ),
                            on_click=self.new_chat,
                        ),
                        padding=ft.padding.all(12),
                    ),
                    
                    # History placeholder
                    ft.Container(
                        content=ft.Column(
                            [
                                ft.Text("💬", size=28),
                                ft.Text("Chat history", size=12, color=COLORS["text_secondary"]),
                                ft.Text("appears here", size=11, color=COLORS["text_muted"]),
                            ],
                            horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                            spacing=4,
                        ),
                        expand=True,
                        alignment=ft.alignment.center,
                    ),
                    
                    # Settings button
                    ft.Container(
                        content=ft.TextButton(
                            content=ft.Row(
                                [
                                    ft.Icon(ft.icons.SETTINGS_OUTLINED, size=16, color=COLORS["text_secondary"]),
                                    ft.Text("Settings", size=13, color=COLORS["text_secondary"]),
                                ],
                                spacing=8,
                            ),
                            style=ft.ButtonStyle(
                                shape={"": ft.RoundedRectangleBorder(radius=10)},
                                padding={"": ft.padding.symmetric(horizontal=16, vertical=10)},
                            ),
                            on_click=self.open_settings,
                        ),
                        padding=ft.padding.all(12),
                        border=ft.border.only(top=ft.BorderSide(1, COLORS["border"])),
                    ),
                ],
                spacing=0,
            ),
            width=260,
            bgcolor=COLORS["bg_secondary"],
            border=ft.border.only(right=ft.BorderSide(1, COLORS["border"])),
        )
    
    def build_chat_area(self) -> ft.Container:
        """Build main chat area"""
        # Messages list
        self.messages_list = ft.ListView(
            expand=True,
            spacing=16,
            padding=ft.padding.all(20),
            auto_scroll=True,
        )
        
        # Add welcome message if no messages
        if not self.messages:
            self.messages_list.controls.append(self.build_welcome())
        
        # Input field
        self.input_field = ft.TextField(
            hint_text="Type your message... (Enter to send)",
            hint_style=ft.TextStyle(color=COLORS["text_muted"], size=13),
            border_radius=14,
            bgcolor=COLORS["bg_tertiary"],
            border_color=COLORS["border"],
            focused_border_color=COLORS["accent"],
            cursor_color=COLORS["accent"],
            text_style=ft.TextStyle(color=COLORS["text_primary"], size=13),
            expand=True,
            min_lines=1,
            max_lines=5,
            on_submit=self.send_message,
        )
        
        # Send button
        self.send_button = ft.IconButton(
            icon=ft.icons.SEND_ROUNDED,
            icon_color="white",
            icon_size=18,
            style=ft.ButtonStyle(
                bgcolor={"": COLORS["accent"]},
                shape={"": ft.RoundedRectangleBorder(radius=10)},
            ),
            width=40,
            height=40,
            on_click=self.send_message,
        )
        
        # Model selector
        self.model_dropdown = ft.Dropdown(
            value=self.settings.get("model", "deepseek-v4-pro"),
            options=[
                ft.dropdown.Option("deepseek-v4-pro", "🚀 V4 Pro"),
                ft.dropdown.Option("deepseek-v4-flash", "⚡ V4 Flash"),
            ],
            width=130,
            height=36,
            text_size=12,
            bgcolor=COLORS["bg_tertiary"],
            border_color=COLORS["border"],
            focused_border_color=COLORS["accent"],
            border_radius=10,
            content_padding=ft.padding.symmetric(horizontal=10, vertical=0),
            on_change=self.on_model_change,
        )
        
        # Web search toggle
        self.search_button = ft.ElevatedButton(
            content=ft.Row(
                [
                    ft.Icon(ft.icons.SEARCH, size=14),
                    ft.Text("Search", size=11),
                ],
                spacing=6,
            ),
            style=ft.ButtonStyle(
                bgcolor={"": COLORS["bg_tertiary"]},
                color={"": COLORS["text_secondary"]},
                side={"": ft.BorderSide(1, COLORS["border"])},
                shape={"": ft.RoundedRectangleBorder(radius=10)},
                padding={"": ft.padding.symmetric(horizontal=12, vertical=8)},
            ),
            on_click=self.toggle_search,
        )
        
        # Thinking effort dropdown
        self.thinking_dropdown = ft.Dropdown(
            value=self.settings.get("thinking_effort", "auto"),
            options=[
                ft.dropdown.Option("auto", "✨ Auto"),
                ft.dropdown.Option("none", "⚡ None"),
                ft.dropdown.Option("low", "💫 Low"),
                ft.dropdown.Option("high", "🧠 High"),
                ft.dropdown.Option("max", "🔥 Max"),
            ],
            width=110,
            height=36,
            text_size=12,
            bgcolor=COLORS["bg_tertiary"],
            border_color=COLORS["border"],
            focused_border_color=COLORS["accent"],
            border_radius=10,
            content_padding=ft.padding.symmetric(horizontal=10, vertical=0),
            on_change=self.on_thinking_change,
        )
        
        # Plugins button
        self.plugins_button = ft.ElevatedButton(
            content=ft.Row(
                [
                    ft.Text("🧩", size=12),
                    ft.Text("Plugins", size=11),
                ],
                spacing=6,
            ),
            style=ft.ButtonStyle(
                bgcolor={"": COLORS["bg_tertiary"]},
                color={"": COLORS["text_secondary"]},
                side={"": ft.BorderSide(1, COLORS["border"])},
                shape={"": ft.RoundedRectangleBorder(radius=10)},
                padding={"": ft.padding.symmetric(horizontal=12, vertical=8)},
            ),
            on_click=self.open_plugins,
        )
        
        return ft.Container(
            content=ft.Column(
                [
                    # Top bar
                    ft.Container(
                        content=ft.Row(
                            [
                                ft.Row(
                                    [
                                        ft.Container(
                                            width=8,
                                            height=8,
                                            border_radius=4,
                                            bgcolor=COLORS["success"],
                                        ),
                                        ft.Text("nohomo", size=13, weight=ft.FontWeight.W_500, color=COLORS["text_primary"]),
                                        ft.Text("API MANAGER", size=10, color=COLORS["text_muted"]),
                                    ],
                                    spacing=8,
                                ),
                            ],
                            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                        ),
                        padding=ft.padding.symmetric(horizontal=20, vertical=12),
                        border=ft.border.only(bottom=ft.BorderSide(1, COLORS["border"])),
                        bgcolor=f"{COLORS['bg_secondary']}80",
                    ),
                    
                    # Messages area
                    ft.Container(
                        content=self.messages_list,
                        expand=True,
                    ),
                    
                    # Input area
                    ft.Container(
                        content=ft.Column(
                            [
                                # Control buttons
                                ft.Row(
                                    [
                                        self.model_dropdown,
                                        self.search_button,
                                        self.thinking_dropdown,
                                        self.plugins_button,
                                    ],
                                    spacing=8,
                                ),
                                # Input row
                                ft.Row(
                                    [
                                        self.input_field,
                                        self.send_button,
                                    ],
                                    spacing=10,
                                ),
                                # Footer
                                ft.Text(
                                    "DeepSeek V4 • Tavily Search • nohomo API MANAGER",
                                    size=9,
                                    color=COLORS["text_muted"],
                                    text_align=ft.TextAlign.CENTER,
                                ),
                            ],
                            spacing=12,
                            horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                        padding=ft.padding.all(16),
                        border=ft.border.only(top=ft.BorderSide(1, COLORS["border"])),
                        bgcolor=f"{COLORS['bg_secondary']}50",
                    ),
                ],
                spacing=0,
            ),
            expand=True,
            bgcolor=COLORS["bg_primary"],
        )
    
    def build_welcome(self) -> ft.Container:
        """Build welcome screen"""
        has_key = bool(self.settings.get("deepseek_key"))
        
        return ft.Container(
            content=ft.Column(
                [
                    # Logo
                    ft.Container(
                        content=ft.Text("nh", size=28, weight=ft.FontWeight.BOLD, color="white"),
                        width=80,
                        height=80,
                        border_radius=24,
                        gradient=ft.LinearGradient(
                            colors=[COLORS["accent"], "#a855f7", "#3b82f6"],
                            begin=ft.alignment.top_left,
                            end=ft.alignment.bottom_right,
                        ),
                        alignment=ft.alignment.center,
                        shadow=ft.BoxShadow(
                            spread_radius=0,
                            blur_radius=30,
                            color=f"{COLORS['accent']}40",
                        ),
                    ),
                    ft.Text(
                        "Welcome to nohomo",
                        size=22,
                        weight=ft.FontWeight.BOLD,
                        color=COLORS["text_primary"],
                    ),
                    ft.Text(
                        "The smartest API manager with intelligent web search,\nthinking effort control, and a powerful plugin system.",
                        size=13,
                        color=COLORS["text_secondary"],
                        text_align=ft.TextAlign.CENTER,
                    ),
                    ft.Container(height=16),
                    
                    # Add keys button or features
                    ft.ElevatedButton(
                        content=ft.Row(
                            [
                                ft.Icon(ft.icons.KEY, size=16, color="white"),
                                ft.Text(
                                    "Add API Keys to Get Started" if not has_key else "Settings",
                                    color="white",
                                    size=13,
                                    weight=ft.FontWeight.W_500,
                                ),
                            ],
                            spacing=8,
                        ),
                        style=ft.ButtonStyle(
                            bgcolor={"": COLORS["accent"]},
                            shape={"": ft.RoundedRectangleBorder(radius=14)},
                            padding={"": ft.padding.symmetric(horizontal=24, vertical=14)},
                            shadow_color=f"{COLORS['accent']}40",
                            elevation={"": 8},
                        ),
                        on_click=self.open_settings,
                    ) if not has_key else ft.Row(
                        [
                            self.build_feature_card("🔍", "Smart Search", "Multi-step query planning"),
                            self.build_feature_card("💡", "Thinking Modes", "Auto-adjusting effort"),
                            self.build_feature_card("🧩", "Plugins", "Customize AI behavior"),
                        ],
                        spacing=12,
                    ),
                ],
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                spacing=12,
            ),
            alignment=ft.alignment.center,
            expand=True,
        )
    
    def build_feature_card(self, icon: str, title: str, desc: str) -> ft.Container:
        """Build feature card"""
        return ft.Container(
            content=ft.Column(
                [
                    ft.Text(icon, size=24),
                    ft.Text(title, size=12, weight=ft.FontWeight.W_600, color=COLORS["text_primary"]),
                    ft.Text(desc, size=10, color=COLORS["text_secondary"]),
                ],
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                spacing=4,
            ),
            padding=ft.padding.all(16),
            border_radius=14,
            bgcolor=COLORS["bg_secondary"],
            border=ft.border.all(1, COLORS["border"]),
            width=150,
        )
    
    def build_message_bubble(self, role: str, content: str, reasoning: str = None, search_results: list = None) -> ft.Container:
        """Build chat message bubble"""
        is_user = role == "user"
        
        bubble_content = [
            ft.Markdown(
                content,
                selectable=True,
                extension_set=ft.MarkdownExtensionSet.GITHUB_WEB,
                code_theme="monokai",
                code_style=ft.TextStyle(size=12, font_family="monospace"),
            ) if not is_user else ft.Text(content, size=13, color=COLORS["text_primary"]),
        ]
        
        # Add reasoning content if present
        if reasoning:
            bubble_content.insert(0, ft.Container(
                content=ft.Column([
                    ft.Row([
                        ft.Text("💭", size=12),
                        ft.Text("Thinking Process", size=11, weight=ft.FontWeight.W_600, color=COLORS["thinking"]),
                    ], spacing=6),
                    ft.Text(reasoning[:500] + "..." if len(reasoning) > 500 else reasoning, size=11, color=COLORS["text_secondary"]),
                ], spacing=6),
                padding=ft.padding.all(12),
                border_radius=10,
                bgcolor=f"{COLORS['thinking']}10",
                border=ft.border.all(1, f"{COLORS['thinking']}30"),
                margin=ft.margin.only(bottom=10),
            ))
        
        # Add search results if present
        if search_results:
            sources = ft.Column([
                ft.Row([
                    ft.Text("🔗", size=12),
                    ft.Text(f"Sources ({len(search_results)})", size=11, weight=ft.FontWeight.W_600, color=COLORS["search"]),
                ], spacing=6),
            ] + [
                ft.TextButton(
                    content=ft.Text(f"{i+1}. {r['title'][:50]}...", size=10, color=COLORS["text_secondary"]),
                    url=r["url"],
                ) for i, r in enumerate(search_results[:5])
            ], spacing=2)
            
            bubble_content.append(ft.Container(
                content=sources,
                padding=ft.padding.all(12),
                border_radius=10,
                bgcolor=f"{COLORS['search']}10",
                border=ft.border.all(1, f"{COLORS['search']}30"),
                margin=ft.margin.only(top=10),
            ))
        
        return ft.Container(
            content=ft.Row(
                [
                    ft.Container(
                        content=ft.Column(bubble_content, spacing=0),
                        padding=ft.padding.all(14),
                        border_radius=16 if is_user else ft.border_radius.only(
                            top_left=16, top_right=16, bottom_right=16, bottom_left=4
                        ),
                        bgcolor=f"{COLORS['accent']}20" if is_user else COLORS["bg_secondary"],
                        border=ft.border.all(1, f"{COLORS['accent']}30" if is_user else COLORS["border"]),
                        width=600,
                    ),
                ],
                alignment=ft.MainAxisAlignment.END if is_user else ft.MainAxisAlignment.START,
            ),
        )
    
    async def send_message(self, e):
        """Send message to API"""
        message = self.input_field.value.strip()
        if not message or self.is_loading:
            return
        
        # Check API key
        if not self.settings.get("deepseek_key"):
            self.show_snackbar("⚠️ Please add your DeepSeek API key in Settings")
            return
        
        self.is_loading = True
        self.input_field.value = ""
        self.input_field.disabled = True
        self.send_button.disabled = True
        
        # Remove welcome screen
        if len(self.messages_list.controls) == 1 and not self.messages:
            self.messages_list.controls.clear()
        
        # Add user message
        self.messages.append({"role": "user", "content": message})
        self.messages_list.controls.append(self.build_message_bubble("user", message))
        
        # Add loading indicator
        loading = ft.Container(
            content=ft.Row([
                ft.ProgressRing(width=16, height=16, stroke_width=2, color=COLORS["accent"]),
                ft.Text("Thinking...", size=12, color=COLORS["text_secondary"]),
            ], spacing=10),
            padding=ft.padding.all(12),
        )
        self.messages_list.controls.append(loading)
        self.page.update()
        
        try:
            # Determine thinking effort
            effort = self.settings.get("thinking_effort", "auto")
            if effort == "auto":
                effort = auto_thinking_effort(message)
            
            # Build messages for API
            system_prompt = build_system_prompt(self.settings.get("enabled_plugins", []))
            search_context = None
            search_results = None
            
            # Smart search if enabled
            if self.web_search_enabled and self.settings.get("tavily_key"):
                if should_auto_search(message) or self.web_search_enabled:
                    context = "\n".join([f"{m['role']}: {m['content']}" for m in self.messages[-4:]])
                    search_context = await smart_search(
                        message, context,
                        self.settings["deepseek_key"],
                        self.settings["tavily_key"]
                    )
                    if search_context["results"]:
                        search_results = search_context["results"]
                        system_prompt += f"\n\n<web_search_results>\nFound {search_context['count']} sources:\n\n{search_context['summary']}\n</web_search_results>\n\nUse search results to provide accurate info. Cite URLs."
            
            api_messages = [{"role": "system", "content": system_prompt}]
            for m in self.messages[-20:]:
                api_messages.append({"role": m["role"], "content": m["content"]})
            
            # Call API
            result = await chat_completion(
                api_messages,
                self.settings.get("model", "deepseek-v4-pro"),
                self.settings["deepseek_key"],
                effort,
            )
            
            # Remove loading
            self.messages_list.controls.remove(loading)
            
            if result.get("error"):
                self.show_snackbar(f"❌ {result['message']}")
            else:
                content = result["content"]
                reasoning = result.get("reasoning_content")
                
                self.messages.append({"role": "assistant", "content": content})
                self.messages_list.controls.append(
                    self.build_message_bubble("assistant", content, reasoning, search_results)
                )
                
                # Save history
                save_history(self.messages)
        
        except Exception as ex:
            self.messages_list.controls.remove(loading)
            self.show_snackbar(f"❌ Error: {str(ex)}")
        
        finally:
            self.is_loading = False
            self.input_field.disabled = False
            self.send_button.disabled = False
            self.page.update()
    
    def new_chat(self, e):
        """Start new chat"""
        self.messages = []
        self.messages_list.controls.clear()
        self.messages_list.controls.append(self.build_welcome())
        self.page.update()
    
    def toggle_search(self, e):
        """Toggle web search"""
        self.web_search_enabled = not self.web_search_enabled
        
        if self.web_search_enabled:
            self.search_button.style.bgcolor = {"": f"{COLORS['search']}20"}
            self.search_button.style.color = {"": COLORS["search"]}
            self.search_button.style.side = {"": ft.BorderSide(1, f"{COLORS['search']}40")}
        else:
            self.search_button.style.bgcolor = {"": COLORS["bg_tertiary"]}
            self.search_button.style.color = {"": COLORS["text_secondary"]}
            self.search_button.style.side = {"": ft.BorderSide(1, COLORS["border"])}
        
        self.page.update()
    
    def on_model_change(self, e):
        """Handle model change"""
        self.settings["model"] = e.control.value
        save_settings(self.settings)
    
    def on_thinking_change(self, e):
        """Handle thinking effort change"""
        self.settings["thinking_effort"] = e.control.value
        save_settings(self.settings)
    
    def open_settings(self, e):
        """Open settings dialog"""
        deepseek_field = ft.TextField(
            label="DeepSeek API Key",
            value=self.settings.get("deepseek_key", ""),
            password=True,
            can_reveal_password=True,
            border_radius=10,
            bgcolor=COLORS["bg_tertiary"],
            border_color=COLORS["border"],
            focused_border_color=COLORS["accent"],
            label_style=ft.TextStyle(color=COLORS["text_secondary"]),
            text_style=ft.TextStyle(color=COLORS["text_primary"]),
            hint_text="sk-...",
            hint_style=ft.TextStyle(color=COLORS["text_muted"]),
        )
        
        tavily_field = ft.TextField(
            label="Tavily API Key (for Web Search)",
            value=self.settings.get("tavily_key", ""),
            password=True,
            can_reveal_password=True,
            border_radius=10,
            bgcolor=COLORS["bg_tertiary"],
            border_color=COLORS["border"],
            focused_border_color=COLORS["accent"],
            label_style=ft.TextStyle(color=COLORS["text_secondary"]),
            text_style=ft.TextStyle(color=COLORS["text_primary"]),
            hint_text="tvly-...",
            hint_style=ft.TextStyle(color=COLORS["text_muted"]),
        )
        
        def save_and_close(e):
            self.settings["deepseek_key"] = deepseek_field.value
            self.settings["tavily_key"] = tavily_field.value
            save_settings(self.settings)
            dlg.open = False
            self.page.update()
            
            # Refresh welcome if needed
            if len(self.messages_list.controls) == 1 and not self.messages:
                self.messages_list.controls.clear()
                self.messages_list.controls.append(self.build_welcome())
                self.page.update()
        
        dlg = ft.AlertDialog(
            modal=True,
            title=ft.Text("Settings", size=18, weight=ft.FontWeight.BOLD, color=COLORS["text_primary"]),
            bgcolor=COLORS["bg_secondary"],
            content=ft.Container(
                content=ft.Column([
                    ft.Text("Get keys from:", size=12, color=COLORS["text_secondary"]),
                    ft.TextButton("platform.deepseek.com", url="https://platform.deepseek.com"),
                    ft.TextButton("app.tavily.com (1000 free/month)", url="https://app.tavily.com"),
                    ft.Container(height=10),
                    deepseek_field,
                    ft.Container(height=10),
                    tavily_field,
                ], spacing=4),
                width=400,
                padding=ft.padding.all(10),
            ),
            actions=[
                ft.TextButton("Cancel", on_click=lambda e: setattr(dlg, 'open', False) or self.page.update()),
                ft.ElevatedButton(
                    "Save",
                    style=ft.ButtonStyle(bgcolor={"": COLORS["accent"]}, color={"": "white"}),
                    on_click=save_and_close,
                ),
            ],
        )
        
        self.page.overlay.append(dlg)
        dlg.open = True
        self.page.update()
    
    def open_plugins(self, e):
        """Open plugins dialog"""
        enabled = self.settings.get("enabled_plugins", [])
        
        plugin_controls = []
        for plugin in PLUGINS:
            is_enabled = plugin["id"] in enabled
            
            switch = ft.Switch(
                value=is_enabled,
                active_color=COLORS["accent"],
                data=plugin["id"],
            )
            
            plugin_controls.append(
                ft.Container(
                    content=ft.Row([
                        ft.Text(plugin["icon"], size=20),
                        ft.Column([
                            ft.Text(plugin["name"], size=13, weight=ft.FontWeight.W_600, color=COLORS["text_primary"]),
                            ft.Text(plugin["description"], size=11, color=COLORS["text_secondary"]),
                        ], spacing=2, expand=True),
                        switch,
                    ], spacing=12),
                    padding=ft.padding.all(12),
                    border_radius=10,
                    bgcolor=f"{COLORS['accent']}10" if is_enabled else COLORS["bg_tertiary"],
                    border=ft.border.all(1, f"{COLORS['accent']}30" if is_enabled else COLORS["border"]),
                )
            )
        
        def on_switch_change(e):
            plugin_id = e.control.data
            if e.control.value:
                if plugin_id not in enabled:
                    enabled.append(plugin_id)
            else:
                if plugin_id in enabled:
                    enabled.remove(plugin_id)
            self.settings["enabled_plugins"] = enabled
            save_settings(self.settings)
        
        for control in plugin_controls:
            control.content.controls[-1].on_change = on_switch_change
        
        dlg = ft.AlertDialog(
            modal=True,
            title=ft.Text("🧩 Plugins", size=18, weight=ft.FontWeight.BOLD, color=COLORS["text_primary"]),
            bgcolor=COLORS["bg_secondary"],
            content=ft.Container(
                content=ft.Column(plugin_controls, spacing=8, scroll=ft.ScrollMode.AUTO),
                width=450,
                height=400,
                padding=ft.padding.all(10),
            ),
            actions=[
                ft.ElevatedButton(
                    "Done",
                    style=ft.ButtonStyle(bgcolor={"": COLORS["accent"]}, color={"": "white"}),
                    on_click=lambda e: setattr(dlg, 'open', False) or self.page.update(),
                ),
            ],
        )
        
        self.page.overlay.append(dlg)
        dlg.open = True
        self.page.update()
    
    def show_snackbar(self, message: str):
        """Show snackbar notification"""
        self.page.snack_bar = ft.SnackBar(
            content=ft.Text(message, color=COLORS["text_primary"]),
            bgcolor=COLORS["bg_elevated"],
        )
        self.page.snack_bar.open = True
        self.page.update()


def main(page: ft.Page):
    NohomoApp(page)


if __name__ == "__main__":
    ft.app(target=main)
