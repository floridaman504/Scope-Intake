import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [employee, setEmployee] = useState(null); // { role, full_name, email }
  const [loading, setLoading] = useState(true);

  const loadEmployee = async (userId) => {
    if (!userId) {
      setEmployee(null);
      return;
    }
    const { data, error } = await supabase
      .from('employees')
      .select('role, full_name, email')
      .eq('user_id', userId)
      .single();
    if (!error && data) {
      setEmployee(data);
    } else {
      setEmployee(null);
    }
  };

  useEffect(() => {
    // Check current session on load
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      loadEmployee(session?.user?.id).finally(() => setLoading(false));
    });

    // Listen for login/logout changes
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      loadEmployee(session?.user?.id);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setEmployee(null);
  };

  return (
    <AuthContext.Provider value={{ session, employee, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
