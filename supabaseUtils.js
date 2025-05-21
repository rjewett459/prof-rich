// supabaseUtils.js
import supabase from "./supabaseClient.js";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getOrCreateThreadId(user_id) {
  console.log("🔍 Looking for existing thread for:", user_id);

  const { data, error } = await supabase
    .from("user_threads")
    .select("thread_id")
    .eq("user_id", user_id)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("🔥 Supabase select error:", error);
    throw error;
  }

  if (data?.thread_id) {
    console.log("✅ Found existing thread:", data.thread_id);
    return data.thread_id;
  }

  console.log("🧵 No thread found — creating new one in OpenAI...");
  const thread = await openai.beta.threads.create();
  const newThreadId = thread.id;
  console.log("🧵 New thread created:", newThreadId);

  const { error: upsertError } = await supabase
    .from("user_threads")
    .upsert({ user_id, thread_id: newThreadId }, { onConflict: "user_id" });

  if (upsertError) {
    console.error("🔥 Supabase upsert error:", upsertError);
    throw upsertError;
  }

  console.log("✅ Supabase upsert successful for:", user_id);
  return newThreadId;
}
