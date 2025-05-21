// supabaseUtils.js
import supabase from "./supabaseClient.js";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getOrCreateThreadId(user_id) {
  const { data, error } = await supabase
    .from("user_threads")
    .select("thread_id")
    .eq("user_id", user_id)
    .single();

  if (data?.thread_id) {
    return data.thread_id;
  }

  const thread = await openai.beta.threads.create();
  const newThreadId = thread.id;

  const { error: insertError } = await supabase
    .from("user_threads")
    .insert({ user_id, thread_id: newThreadId });

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    throw insertError;
  }

  return newThreadId;
}
