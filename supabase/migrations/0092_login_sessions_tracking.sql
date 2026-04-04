-- Create user_login_sessions table for tracking active and historical user sessions
CREATE TABLE IF NOT EXISTS user_login_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  session_end TIMESTAMP WITH TIME ZONE,
  ip_address INET,
  user_agent TEXT,
  device_info JSONB DEFAULT '{}'::JSONB,
  last_activity TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX idx_user_login_sessions_user_id ON user_login_sessions(user_id);
CREATE INDEX idx_user_login_sessions_tenant_id ON user_login_sessions(tenant_id);
CREATE INDEX idx_user_login_sessions_session_start ON user_login_sessions(session_start DESC);
CREATE INDEX idx_user_login_sessions_last_activity ON user_login_sessions(last_activity DESC);

-- Enable RLS
ALTER TABLE user_login_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own sessions
CREATE POLICY "Users can view their own login sessions"
  ON user_login_sessions
  FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Admin members can view sessions for their tenant
CREATE POLICY "Admins can view tenant login sessions"
  ON user_login_sessions
  FOR SELECT
  USING (
    auth.uid() IN (
      SELECT m.user_id
      FROM memberships m
      WHERE m.tenant_id = user_login_sessions.tenant_id
        AND m.role = 'admin'
    )
  );

-- RLS Policy: Only backend/service can insert/update sessions
CREATE POLICY "Service can manage login sessions"
  ON user_login_sessions
  FOR ALL
  USING (true)
  WITH CHECK (true);
