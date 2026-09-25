// Minimal Luau script runner (no CMake, no readline/isocline).
// Usage: luau-run <entry.luau> [args...]
// Provides a `require(path)` global that loads sibling .luau files relative
// to the requiring file, with a per-process module cache.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>

#include "lua.h"
#include "lualib.h"
#include "luacode.h"

static std::vector<std::string> gDirStack;

static std::string dirnameOf(const std::string& path) {
    size_t p = path.find_last_of("/\\");
    if (p == std::string::npos) return ".";
    if (p == 0) return "/";
    return path.substr(0, p);
}

static std::string joinPath(const std::string& dir, const std::string& rel) {
    if (rel.empty()) return dir;
    if (rel[0] == '/' || rel[0] == '\\') return rel;
    // Handle ../ and ./ segments lexically.
    std::string out = dir;
    if (!out.empty() && out.back() != '/' && out.back() != '\\') out += '/';
    out += rel;
    std::vector<std::string> parts;
    std::string cur;
    for (size_t i = 0; i <= out.size(); i++) {
        if (i == out.size() || out[i] == '/' || out[i] == '\\') {
            if (cur == "..") { if (!parts.empty()) parts.pop_back(); }
            else if (cur != "." && !cur.empty()) parts.push_back(cur);
            cur.clear();
        } else cur += out[i];
    }
    std::string res;
    if (!out.empty() && (out[0] == '/' || out[0] == '\\')) res = "/";
    for (size_t i = 0; i < parts.size(); i++) {
        if (i) res += '/';
        res += parts[i];
    }
    return res.empty() ? "." : res;
}

static bool readFile(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

static int runSource(lua_State* L, const std::string& path, const std::string& source, const char* chunkname) {
    size_t bytecodeSize = 0;
    char* bytecode = luau_compile(source.c_str(), source.size(), NULL, &bytecodeSize);
    if (!bytecode) {
        lua_pushfstring(L, "compile error in %s", path.c_str());
        return LUA_ERRSYNTAX;
    }
    int res = luau_load(L, chunkname, bytecode, (int)bytecodeSize, 0);
    free(bytecode);
    if (res != 0) return res;
    res = lua_pcall(L, 0, 1, 0);
    return res;
}

static int l_require(lua_State* L) {
    const char* req = luaL_checkstring(L, 1);
    std::string base = gDirStack.empty() ? "." : gDirStack.back();
    std::string path = joinPath(base, req);
    // Try as-is, then with .luau appended.
    std::string source;
    std::string found;
    if (readFile(path, source)) found = path;
    else if (readFile(path + ".luau", source)) found = path + ".luau";
    else {
        luaL_error(L, "require: cannot open '%s' (from '%s')", req, base.c_str());
        return 0;
    }

    // Module cache in registry: key = "luau-run:module:" .. found
    std::string key = std::string("luau-run:module:") + found;
    lua_pushstring(L, key.c_str());
    lua_rawget(L, LUA_REGISTRYINDEX);
    if (!lua_isnil(L, -1)) return 1; // cached
    lua_pop(L, 1);

    gDirStack.push_back(dirnameOf(found));
    std::string chunkname = "=" + found;
    int res = runSource(L, found, source, chunkname.c_str());
    gDirStack.pop_back();
    if (res != 0) {
        const char* msg = lua_tostring(L, -1);
        luaL_error(L, "%s", msg ? msg : "require failed");
        return 0;
    }
    // Cache result.
    lua_pushstring(L, key.c_str());
    lua_pushvalue(L, -2);
    lua_rawset(L, LUA_REGISTRYINDEX);
    return 1;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <entry.luau> [args...]\n", argv[0]);
        return 2;
    }
    std::string entry = argv[1];
    std::string source;
    if (!readFile(entry, source)) {
        fprintf(stderr, "cannot open '%s'\n", entry.c_str());
        return 2;
    }

    lua_State* L = luaL_newstate();
    luaL_openlibs(L);

    // argv table for tests that want it.
    lua_newtable(L);
    for (int i = 2; i < argc; i++) {
        lua_pushstring(L, argv[i]);
        lua_rawseti(L, -2, i - 1);
    }
    lua_setglobal(L, "arg");

    lua_pushcfunction(L, l_require, "require");
    lua_setglobal(L, "require");

    gDirStack.push_back(dirnameOf(entry));
    std::string chunkname = "=" + entry;
    int res = runSource(L, entry, source, chunkname.c_str());
    gDirStack.pop_back();

    if (res != 0) {
        const char* msg = lua_tostring(L, -1);
        fprintf(stderr, "error: %s\n", msg ? msg : "?");
        lua_close(L);
        return 1;
    }
    // Entry return value: if boolean false or nonzero number? Convention:
    // tests call os.exit themselves. Just close.
    lua_close(L);
    return 0;
}
