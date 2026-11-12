# Sourced with $W set: throwaway HOME and XDG dirs, no auto-update, password for serve and client.
mkdir -p $W/home/{cfg,data,state,cache} $W/proj
export HOME=$W/home XDG_CONFIG_HOME=$W/home/cfg XDG_DATA_HOME=$W/home/data XDG_STATE_HOME=$W/home/state XDG_CACHE_HOME=$W/home/cache
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_SERVER_PASSWORD=$PW OPENCODE_PASSWORD=$PW
