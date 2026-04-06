local logger     = require("logger")
local millennium = require("millennium")

function execute_shutdown()
    os.execute("shutdown /s /t 0")
end

function cancel_shutdown()
    os.execute("shutdown /a")
end

local function on_load()
    logger:info("Auto Shutdown loaded (Millennium " .. millennium.version() .. ")")
    millennium.ready()
end

local function on_unload()
end

local function on_frontend_loaded()
end

return {
    on_load            = on_load,
    on_unload          = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
